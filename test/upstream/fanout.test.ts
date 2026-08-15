import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createEgressClient } from "../../src/infra/egress/client";
import { createFanout, withSupplements } from "../../src/infra/upstream/fanout";
import { createGitHubProvider } from "../../src/infra/upstream/github";
import { createRotation } from "../../src/infra/upstream/rotation";
import {
	type Candidate,
	interleaveAll,
	type SearchProvider,
	UpstreamError,
} from "../../src/infra/upstream/types";
import { createWikipediaProvider } from "../../src/infra/upstream/wikipedia";

/**
 * Fan-out, and the free specialists that ride alongside it.
 *
 * The properties worth asserting here are all about *not* making a query worse.
 * Fan-out's whole justification is a wider candidate set, and every way it can
 * go wrong is a way of losing results that a plain rotation would have
 * returned: one vendor's failure discarding another's answer, a specialist
 * crowding out the general web, a free retriever's rate limit becoming the
 * query's problem.
 */

let servers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.map(
			(server) => new Promise<void>((resolve) => server.close(() => resolve())),
		),
	);
	servers = [];
});

async function serve(
	handler: Parameters<typeof createServer>[1],
): Promise<string> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Loopback is refused by the real policy; these test parsing, not egress. */
function client() {
	return createEgressClient(
		{
			timeoutMs: 1_500,
			maxBytes: 512 * 1024,
			maxRedirects: 2,
			userAgent: "CheelaSearchBot/0.1 (+test)",
		},
		{
			resolve: async () => ["127.0.0.1"],
			classify: () => ({ allowed: true }) as const,
			allowPort: () => true,
		},
	);
}

/** A provider that answers with the URLs it was built with. */
function stub(name: string, urls: string[]): SearchProvider {
	return {
		name,
		async search(): Promise<Candidate[]> {
			return urls.map((url, index) => ({
				url,
				title: `${name} ${index}`,
				rank: index + 1,
				provider: name,
			}));
		},
	};
}

function broken(name: string): SearchProvider {
	return {
		name,
		async search(): Promise<Candidate[]> {
			throw new UpstreamError(name, "vendor is down");
		},
	};
}

describe("interleaveAll", () => {
	const list = (...urls: string[]): Candidate[] =>
		urls.map((url, index) => ({
			url,
			title: null,
			rank: index + 1,
			provider: "p",
		}));

	it("takes one from each list in turn", () => {
		const merged = interleaveAll([list("a", "b", "c"), list("x", "y", "z")], 6);
		expect(merged.map((c) => c.url)).toEqual(["a", "x", "b", "y", "c", "z"]);
	});

	/**
	 * The reason round-robin rather than concatenation: the tail of a list is
	 * where its weakest results live, and appending would spend the whole budget
	 * there before the second list's best result was ever fetched.
	 */
	it("does not spend the budget on one list's tail", () => {
		const merged = interleaveAll([list("a", "b", "c", "d"), list("x")], 2);
		expect(merged.map((c) => c.url)).toEqual(["a", "x"]);
	});

	it("keeps the first sight of a URL two providers both returned", () => {
		const merged = interleaveAll([list("a", "dup"), list("dup", "b")], 10);
		expect(merged.map((c) => c.url)).toEqual(["a", "dup", "b"]);
	});

	it("drains the lists that still have results when others run out", () => {
		const merged = interleaveAll([list("a"), list("x", "y", "z")], 10);
		expect(merged.map((c) => c.url)).toEqual(["a", "x", "y", "z"]);
	});

	it("terminates on empty input rather than spinning", () => {
		expect(interleaveAll([], 10)).toEqual([]);
		expect(interleaveAll([[], []], 10)).toEqual([]);
	});
});

describe("createFanout", () => {
	it("merges every provider's results", async () => {
		const fanout = createFanout([
			stub("one", ["https://a.test/", "https://b.test/"]),
			stub("two", ["https://x.test/", "https://y.test/"]),
		]);

		const result = await fanout.search("q", { limit: 4 });
		expect(result.candidates.map((c) => c.url)).toEqual([
			"https://a.test/",
			"https://x.test/",
			"https://b.test/",
			"https://y.test/",
		]);
		expect(result.provider).toBe("one");
		expect(result.failures).toEqual([]);
	});

	/**
	 * The failure mode fan-out exists to avoid. `Promise.all` would discard a
	 * working vendor's answer because another one was down, which is strictly
	 * worse than the rotation this replaced.
	 */
	it("keeps a working vendor's answer when another one fails", async () => {
		const fanout = createFanout([
			broken("down"),
			stub("up", ["https://a.test/"]),
		]);

		const result = await fanout.search("q", { limit: 4 });
		expect(result.candidates.map((c) => c.url)).toEqual(["https://a.test/"]);
		expect(result.provider).toBe("up");
		expect(result.failures).toEqual([
			{ provider: "down", detail: "down: vendor is down" },
		]);
	});

	/**
	 * `provider: null` means every vendor failed, and the pipeline turns that
	 * into an error frame. A vendor that answered with nothing has done its job,
	 * so conflating the two would report an ordinary unanswerable query as an
	 * outage.
	 */
	it("reports a provider even when it answered with nothing", async () => {
		const result = await createFanout([stub("empty", [])]).search("q");
		expect(result.provider).toBe("empty");
		expect(result.candidates).toEqual([]);
	});

	it("reports null only when every provider failed", async () => {
		const result = await createFanout([broken("a"), broken("b")]).search("q");
		expect(result.provider).toBeNull();
		expect(result.failures).toHaveLength(2);
	});

	it("refuses to be constructed over nothing", () => {
		expect(() => createFanout([])).toThrow(/at least one provider/);
	});
});

describe("withSupplements", () => {
	const primary = () =>
		createRotation([stub("tavily", ["https://p1.test/", "https://p2.test/"])]);

	it("adds specialist results without displacing the general ones", async () => {
		const supplemented = withSupplements(primary(), [
			stub("wikipedia", ["https://w1.test/"]),
		]);

		const result = await supplemented.search("q", { limit: 2 });
		const urls = result.candidates.map((c) => c.url);

		// Both primary results survive — the specialist is additive within a small
		// ceiling, not a competitor for the same two slots. On "nike jordans" the
		// alternative is an encyclopedia article crowding out a shop.
		expect(urls).toContain("https://p1.test/");
		expect(urls).toContain("https://p2.test/");
		expect(urls).toContain("https://w1.test/");
	});

	/**
	 * GitHub will rate-limit; that is a designed-for condition rather than an
	 * incident. A query must not get worse because a free retriever ran out of
	 * quota.
	 */
	it("is unharmed by a specialist that fails", async () => {
		const supplemented = withSupplements(primary(), [broken("github")]);

		const result = await supplemented.search("q", { limit: 2 });
		expect(result.candidates.map((c) => c.url)).toEqual([
			"https://p1.test/",
			"https://p2.test/",
		]);
		expect(result.provider).toBe("tavily");
		// Reported for the trace, and nothing branches on it.
		expect(result.failures).toEqual([
			{ provider: "github", detail: "github: vendor is down" },
		]);
	});

	/**
	 * The one case where a specialist changes the verdict. A degraded answer from
	 * Wikipedia beats "no search provider answered" on a query we can still
	 * answer.
	 */
	it("rescues a query when every paid vendor failed", async () => {
		const supplemented = withSupplements(createRotation([broken("tavily")]), [
			stub("wikipedia", ["https://w1.test/"]),
		]);

		const result = await supplemented.search("q", { limit: 4 });
		expect(result.candidates.map((c) => c.url)).toEqual(["https://w1.test/"]);
		expect(result.provider).toBe("wikipedia");
	});

	/**
	 * `withQueryCache` walks `names` looking for a cached entry, and the cache is
	 * keyed by the provider that answered — always a primary name when there was
	 * one. Listing the specialists here would make it probe for keys nothing
	 * writes.
	 */
	it("exposes only the primary's names, for the query cache to walk", () => {
		const supplemented = withSupplements(primary(), [stub("wikipedia", [])]);
		expect(supplemented.names).toEqual(["tavily"]);
	});

	it("is the identity when there are no specialists configured", () => {
		const rotation = primary();
		expect(withSupplements(rotation, [])).toBe(rotation);
	});
});

describe("the wikipedia provider", () => {
	it("builds article URLs from the titles the API returns", async () => {
		const base = await serve((_req, res) =>
			res.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({
					query: {
						search: [{ title: "HNSW" }, { title: "Air Jordan (brand)" }],
					},
				}),
			),
		);

		const provider = createWikipediaProvider(
			client(),
			`${base}/w/api.php`,
			"https://en.wikipedia.org/wiki/",
		);
		const results = await provider.search("q", { limit: 5 });

		expect(results.map((r) => r.url)).toEqual([
			"https://en.wikipedia.org/wiki/HNSW",
			// Spaces become underscores; parentheses are legal and stay legible.
			"https://en.wikipedia.org/wiki/Air_Jordan_(brand)",
		]);
		expect(results[0]?.provider).toBe("wikipedia");
	});

	/**
	 * A missing `query.search` is a changed contract, not an empty result set.
	 * Conflating them turns a vendor breaking their API into "no answer for that
	 * query", which is the quietest possible outage.
	 */
	it("treats a missing results array as a broken contract", async () => {
		const base = await serve((_req, res) =>
			res
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ query: {} })),
		);

		const provider = createWikipediaProvider(client(), `${base}/w/api.php`);
		await expect(provider.search("q")).rejects.toThrow(/API shape has changed/);
	});

	it("reports a non-200 as an upstream failure", async () => {
		const base = await serve((_req, res) => res.writeHead(503).end());
		const provider = createWikipediaProvider(client(), `${base}/w/api.php`);
		await expect(provider.search("q")).rejects.toThrow(/HTTP 503/);
	});
});

describe("the github provider", () => {
	it("takes the repository URL, not the API URL", async () => {
		const base = await serve((_req, res) =>
			res.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({
					items: [
						{
							html_url: "https://github.com/pgvector/pgvector",
							full_name: "pgvector/pgvector",
						},
					],
				}),
			),
		);

		const provider = createGitHubProvider("token", client(), base);
		const results = await provider.search("pgvector hnsw", { limit: 5 });

		expect(results[0]?.url).toBe("https://github.com/pgvector/pgvector");
		expect(results[0]?.title).toBe("pgvector/pgvector");
	});

	/**
	 * A bare "HTTP 403" from this provider reads as a credential problem and
	 * sends somebody to check a token that is working fine. It is the rate limit,
	 * every time.
	 */
	it("names a rate limit as a rate limit", async () => {
		for (const status of [403, 429]) {
			const base = await serve((_req, res) => res.writeHead(status).end());
			const provider = createGitHubProvider("token", client(), base);
			await expect(provider.search("q")).rejects.toThrow(/rate limited/);
		}
	});
});
