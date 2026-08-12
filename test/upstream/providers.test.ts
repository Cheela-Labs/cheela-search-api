import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createEgressClient } from "../../src/infra/egress/client";
import { createAnySearchProvider } from "../../src/infra/upstream/anysearch";
import { createGoogleCseProvider } from "../../src/infra/upstream/google-cse";
import { createRotation } from "../../src/infra/upstream/rotation";
import { createTavilyProvider } from "../../src/infra/upstream/tavily";
import {
	normaliseCandidates,
	type SearchProvider,
	UpstreamError,
} from "../../src/infra/upstream/types";

/**
 * Providers, against fixture servers rather than the live vendors.
 *
 * Deliberate, and not only for speed: a suite that calls a real API is
 * non-deterministic, burns quota on every run, and fails when a vendor has a bad
 * afternoon — none of which says anything about this code.
 *
 * The cost is the one recorded in each provider's header: these fixtures assert
 * the shape the implementation *expects*, so a wrong expectation passes here and
 * fails in production. That is a known gap and it closes one way only — by
 * reconciling against one real response per vendor. Until then the value here is
 * in the failure paths, which are the same whatever the exact field names are.
 */

const CONFIG = {
	timeoutMs: 1_500,
	maxBytes: 256 * 1024,
	maxRedirects: 1,
	userAgent: "CheelaSearchBot/0.1 (+test)",
};

let servers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.map(
			(server) => new Promise<void>((resolve) => server.close(() => resolve())),
		),
	);
	servers = [];
});

/** Serves one canned response, and records what it was asked for. */
async function fixture(handler: Parameters<typeof createServer>[1]) {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return (server.address() as AddressInfo).port;
}

/** Reaches loopback on any port, with the real policy stood down. */
function loopbackClient() {
	return createEgressClient(CONFIG, {
		resolve: async () => ["127.0.0.1"],
		classify: () => ({ allowed: true }) as const,
		allowPort: () => true,
	});
}

const endpointFor = (port: number) => `http://127.0.0.1:${port}/`;

describe("normaliseCandidates", () => {
	it("drops anything that is not an http(s) URL", () => {
		const out = normaliseCandidates(
			[
				{ url: "https://a.test/1", title: "One" },
				{ url: "javascript:alert(1)" },
				{ url: "/relative/path" },
				{ url: "ftp://files.test/x" },
				{ url: 42 },
				{},
			],
			"p",
			10,
		);
		expect(out.map((c) => c.url)).toEqual(["https://a.test/1"]);
	});

	it("treats two URLs differing only by fragment as one page", () => {
		const out = normaliseCandidates(
			[{ url: "https://a.test/x#intro" }, { url: "https://a.test/x#summary" }],
			"p",
			10,
		);
		// The fragment never changes what the server returns, so fetching both
		// would be the same page twice and two passages from one source.
		expect(out).toHaveLength(1);
		expect(out[0]?.url).toBe("https://a.test/x");
	});

	it("renumbers rank after dropping, so positions have no holes", () => {
		const out = normaliseCandidates(
			[
				{ url: "not a url" },
				{ url: "https://a.test/1" },
				{ url: "https://a.test/2" },
			],
			"p",
			10,
		);
		expect(out.map((c) => c.rank)).toEqual([1, 2]);
	});

	it("never returns more than the limit", () => {
		const raw = Array.from({ length: 20 }, (_, i) => ({
			url: `https://a.test/${i}`,
		}));
		expect(normaliseCandidates(raw, "p", 5)).toHaveLength(5);
	});

	it("nulls a blank title rather than carrying an empty string", () => {
		const out = normaliseCandidates(
			[{ url: "https://a.test/1", title: "   " }],
			"p",
			10,
		);
		expect(out[0]?.title).toBeNull();
	});
});

describe("tavily provider", () => {
	it("asks for URLs only, and never for a composed answer", async () => {
		let received: Record<string, unknown> = {};
		let auth: string | undefined;
		const port = await fixture((request, response) => {
			auth = request.headers.authorization;
			let raw = "";
			request.on("data", (chunk) => {
				raw += chunk;
			});
			request.on("end", () => {
				received = JSON.parse(raw) as Record<string, unknown>;
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						results: [
							{ url: "https://a.test/1", title: "One", content: "snippet" },
						],
					}),
				);
			});
		});

		const provider = createTavilyProvider(
			"tvly-key",
			loopbackClient(),
			endpointFor(port),
		);
		const candidates = await provider.search("a query", { limit: 3 });

		expect(auth).toBe("Bearer tvly-key");
		expect(received.query).toBe("a query");
		expect(received.max_results).toBe(3);
		// Taking either of these would mean shipping the vendor's summary as
		// ours, which is what the fetch-and-read pipeline exists to avoid.
		expect(received.include_answer).toBe(false);
		expect(received.include_raw_content).toBe(false);

		expect(candidates).toEqual([
			{
				url: "https://a.test/1",
				title: "One",
				rank: 1,
				provider: "tavily",
			},
		]);
		// The vendor sent a snippet in `content`; it must not appear on the
		// candidate at all.
		expect(JSON.stringify(candidates)).not.toContain("snippet");
	});

	it("treats a missing results array as a changed contract, not an empty result", async () => {
		const port = await fixture((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ answer: "here you go" }));
		});

		const provider = createTavilyProvider(
			"k",
			loopbackClient(),
			endpointFor(port),
		);
		await expect(provider.search("q")).rejects.toBeInstanceOf(UpstreamError);
	});

	it("surfaces a non-200 as an upstream failure carrying the status", async () => {
		const port = await fixture((_request, response) => {
			response.writeHead(401, { "content-type": "application/json" });
			response.end(JSON.stringify({ detail: "bad key" }));
		});

		const provider = createTavilyProvider(
			"wrong",
			loopbackClient(),
			endpointFor(port),
		);
		await expect(provider.search("q")).rejects.toThrow(/HTTP 401/);
	});
});

describe("google cse provider", () => {
	it("clamps num to the API's maximum of 10", async () => {
		let asked: string | null = null;
		const port = await fixture((request, response) => {
			asked = new URL(request.url ?? "", "http://x").searchParams.get("num");
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ items: [] }));
		});

		const provider = createGoogleCseProvider(
			"k",
			"cx",
			loopbackClient(),
			endpointFor(port),
		);
		await provider.search("q", { limit: 20 });

		// 20 is rejected by the API outright rather than truncated, so the clamp
		// has to happen before the request goes out.
		expect(asked).toBe("10");
	});

	it("sends the key and engine id the API expects", async () => {
		// A property rather than a `let`: TypeScript narrows a variable whose only
		// assignment is inside a callback to `null` at the assertion below, and
		// the optional chain then collapses to `never`.
		const seen: { params?: URLSearchParams } = {};
		const port = await fixture((request, response) => {
			seen.params = new URL(request.url ?? "", "http://x").searchParams;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({ items: [{ link: "https://a.test/1", title: "T" }] }),
			);
		});

		const provider = createGoogleCseProvider(
			"api-key",
			"engine-id",
			loopbackClient(),
			endpointFor(port),
		);
		const candidates = await provider.search("hello");

		expect(seen.params?.get("key")).toBe("api-key");
		expect(seen.params?.get("cx")).toBe("engine-id");
		expect(seen.params?.get("q")).toBe("hello");
		// `link`, not `url` — the field name differs from Tavily's and mapping it
		// is this provider's whole job.
		expect(candidates[0]?.url).toBe("https://a.test/1");
		expect(candidates[0]?.provider).toBe("google-cse");
	});

	it("reads a missing items key as zero results, which is legitimate", async () => {
		const port = await fixture((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			// The API omits `items` entirely when nothing matched — unlike Tavily,
			// this is not a contract change.
			response.end(
				JSON.stringify({ searchInformation: { totalResults: "0" } }),
			);
		});

		const provider = createGoogleCseProvider(
			"k",
			"cx",
			loopbackClient(),
			endpointFor(port),
		);
		await expect(provider.search("q")).resolves.toEqual([]);
	});

	it("names quota exhaustion rather than reporting a bare 429", async () => {
		const port = await fixture((_request, response) => {
			response.writeHead(429);
			response.end("{}");
		});

		const provider = createGoogleCseProvider(
			"k",
			"cx",
			loopbackClient(),
			endpointFor(port),
		);
		// 100/day runs out quietly; a message saying so saves somebody debugging
		// it as a bug.
		await expect(provider.search("q")).rejects.toThrow(/quota exhausted/);
	});
});

/* -------------------------------------------------------------------------
   The rotation is where the acceptance criterion actually lives, and it needs
   no vendor at all — a provider is an interface, and these are two of them.
   ------------------------------------------------------------------------- */

const stub = (
	name: string,
	behaviour: () => Promise<{ url: string; title?: string }[]>,
): SearchProvider => ({
	name,
	async search(_query, options) {
		const raw = await behaviour();
		return normaliseCandidates(raw, name, options?.limit ?? 10);
	},
});

describe("rotation", () => {
	it("returns the first provider's answer and does not call the second", async () => {
		let secondCalled = false;
		const rotation = createRotation([
			stub("first", async () => [{ url: "https://a.test/1" }]),
			stub("second", async () => {
				secondCalled = true;
				return [];
			}),
		]);

		const result = await rotation.search("q");
		expect(result.provider).toBe("first");
		expect(result.candidates).toHaveLength(1);
		expect(secondCalled).toBe(false);
		expect(result.failures).toEqual([]);
	});

	it("falls through when the first provider throws", async () => {
		const rotation = createRotation([
			stub("first", async () => {
				throw new UpstreamError("first", "HTTP 503", 503);
			}),
			stub("second", async () => [{ url: "https://b.test/1" }]),
		]);

		const result = await rotation.search("q");
		expect(result.provider).toBe("second");
		expect(result.candidates).toHaveLength(1);
		// The failure is reported, not swallowed — otherwise a vendor being down
		// permanently looks exactly like it working.
		expect(result.failures).toEqual([
			{ provider: "first", detail: "first: HTTP 503" },
		]);
	});

	it("does NOT fall through on an empty result set", async () => {
		let secondCalled = false;
		const rotation = createRotation([
			stub("first", async () => []),
			stub("second", async () => {
				secondCalled = true;
				return [{ url: "https://b.test/1" }];
			}),
		]);

		const result = await rotation.search("q");
		// "Nothing matched" is an answer. Sweeping every vendor on every
		// zero-result query spends their quota to reconfirm it.
		expect(result.provider).toBe("first");
		expect(result.candidates).toEqual([]);
		expect(secondCalled).toBe(false);
	});

	it("reports total failure rather than throwing", async () => {
		const rotation = createRotation([
			stub("first", async () => {
				throw new UpstreamError("first", "down");
			}),
			stub("second", async () => {
				throw new UpstreamError("second", "also down");
			}),
		]);

		const result = await rotation.search("q");
		expect(result.provider).toBeNull();
		expect(result.candidates).toEqual([]);
		// The surface renders an error *frame*, so the caller needs the detail,
		// not a stack.
		expect(result.failures.map((f) => f.provider)).toEqual(["first", "second"]);
	});

	it("stops when the caller aborts instead of spending the next vendor's quota", async () => {
		const controller = new AbortController();
		let secondCalled = false;

		const rotation = createRotation([
			stub("first", async () => {
				controller.abort();
				throw new UpstreamError("first", "aborted");
			}),
			stub("second", async () => {
				secondCalled = true;
				return [];
			}),
		]);

		await expect(
			rotation.search("q", { signal: controller.signal }),
		).rejects.toBeInstanceOf(UpstreamError);
		expect(secondCalled).toBe(false);
	});

	it("refuses to be constructed with no providers", () => {
		// A search service whose search is unconfigured should fail at wiring,
		// not answer every query with nothing.
		expect(() => createRotation([])).toThrow(/at least one provider/);
	});

	it("passes the same suite for either provider, by construction", async () => {
		// The acceptance criterion from PLAN.md step 3: swapping the vendor is a
		// config change. Both stubs implement the same interface and the rotation
		// cannot tell them apart, which is what that criterion is really asking.
		for (const name of ["tavily", "google-cse"]) {
			const rotation = createRotation([
				stub(name, async () => [{ url: "https://a.test/1", title: "T" }]),
			]);
			const result = await rotation.search("q");
			expect(result.provider).toBe(name);
			expect(result.candidates[0]).toMatchObject({
				url: "https://a.test/1",
				title: "T",
				rank: 1,
				provider: name,
			});
		}
	});
});

/* -------------------------------------------------------------------------
   AnySearch. Every shape below was read off a real call before the provider
   was written, so these fixtures encode observed behaviour rather than an
   assumption the implementation also makes.
   ------------------------------------------------------------------------- */

describe("anysearch provider", () => {
	const envelope = (results: unknown) => ({
		code: 0,
		message: "Success.",
		request_id: "abc",
		data: { results },
	});

	it("reads results from data.results, not the top level", async () => {
		const port = await fixture((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify(
					envelope([
						{
							title: "One",
							url: "https://a.test/1",
							snippet: "a snippet",
							content: "whole page text",
						},
					]),
				),
			);
		});

		const provider = createAnySearchProvider(
			"as_sk_key",
			loopbackClient(),
			endpointFor(port),
		);
		const candidates = await provider.search("q", { limit: 3 });

		expect(candidates).toEqual([
			{ url: "https://a.test/1", title: "One", rank: 1, provider: "anysearch" },
		]);
		// The vendor returns both a snippet and the page text. Carrying either
		// would mean citing something we never fetched.
		const serialised = JSON.stringify(candidates);
		expect(serialised).not.toContain("snippet");
		expect(serialised).not.toContain("whole page text");
	});

	it("sends the bearer token and clamps max_results to the documented range", async () => {
		const seen: { auth?: string; body?: Record<string, unknown> } = {};
		const port = await fixture((request, response) => {
			seen.auth = request.headers.authorization;
			let raw = "";
			request.on("data", (chunk) => {
				raw += chunk;
			});
			request.on("end", () => {
				seen.body = JSON.parse(raw) as Record<string, unknown>;
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify(envelope([])));
			});
		});

		const provider = createAnySearchProvider(
			"as_sk_key",
			loopbackClient(),
			endpointFor(port),
		);
		await provider.search("hello", { limit: 99 });

		expect(seen.auth).toBe("Bearer as_sk_key");
		expect(seen.body?.query).toBe("hello");
		// Documented as 1–20 and rejected outside it, so the clamp has to happen
		// before the request goes out.
		expect(seen.body?.max_results).toBe(20);
	});

	it("treats an error code as a failure even if the status were 200", async () => {
		// Belt and braces: this API does send real statuses, but an envelope that
		// carries a code usually means for it to be read.
		const port = await fixture((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ code: -1, message: "Quota exceeded." }));
		});

		const provider = createAnySearchProvider(
			"k",
			loopbackClient(),
			endpointFor(port),
		);
		await expect(provider.search("q")).rejects.toThrow(/Quota exceeded/);
	});

	it("surfaces the vendor's message rather than the bare status", async () => {
		const port = await fixture((_request, response) => {
			response.writeHead(401, { "content-type": "application/json" });
			response.end(JSON.stringify({ code: -1, message: "Invalid API key." }));
		});

		const provider = createAnySearchProvider(
			"wrong",
			loopbackClient(),
			endpointFor(port),
		);
		// "Invalid API key." says more in a trace than "HTTP 401" does.
		await expect(provider.search("q")).rejects.toThrow(/Invalid API key/);
	});

	it("treats a missing data.results as a changed contract, not an empty result", async () => {
		const port = await fixture((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ code: 0, message: "Success.", data: {} }));
		});

		const provider = createAnySearchProvider(
			"k",
			loopbackClient(),
			endpointFor(port),
		);
		await expect(provider.search("q")).rejects.toBeInstanceOf(UpstreamError);
	});

	it("returns an empty list when the vendor genuinely found nothing", async () => {
		const port = await fixture((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(envelope([])));
		});

		const provider = createAnySearchProvider(
			"k",
			loopbackClient(),
			endpointFor(port),
		);
		await expect(provider.search("q")).resolves.toEqual([]);
	});
});
