import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
	createEgressClient,
	type EgressConfig,
} from "../../src/infra/egress/client.js";
import { isEgressError } from "../../src/infra/egress/errors.js";
import { createRobotsPolicy } from "../../src/infra/egress/robots.js";

/*
  Real servers on 127.0.0.1, not mocks.

  What is under test here is a policy about *connections* — which addresses,
  which ports, which redirects, how many bytes. A mocked fetch cannot be wrong
  about any of those, so a suite built on one would pass whether or not the
  policy worked. The cost is that the client has to be told 127.0.0.1 is
  acceptable, which is what `classify` and `allowPort` are for, and one test
  below asserts that the *real* classifier still refuses it.
*/

const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
				}),
		),
	);
});

async function serve(
	handler: (
		request: import("node:http").IncomingMessage,
		response: import("node:http").ServerResponse,
	) => void,
): Promise<string> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}`;
}

const settings = (overrides: Partial<EgressConfig> = {}): EgressConfig => ({
	timeoutMs: 2000,
	maxBytes: 100_000,
	maxRedirects: 3,
	userAgent: "CheelaSearchBot/1.0 (+https://search.cheelalabs.com/bot)",
	respectRobots: false,
	...overrides,
});

/** Permits loopback and ephemeral ports; everything else is the real policy. */
const local = {
	classify: () => ({ allowed: true }) as const,
	allowPort: () => true,
};

const client = (overrides: Partial<EgressConfig> = {}, deps = local) =>
	createEgressClient(settings(overrides), deps);

async function refusal(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		throw new Error("expected the request to be refused, but it succeeded");
	} catch (error) {
		if (!isEgressError(error)) throw error;
		return error.reason;
	}
}

describe("the happy path", () => {
	it("fetches a body and reports the headers", async () => {
		const base = await serve((_request, response) => {
			response.writeHead(200, { "content-type": "text/html" });
			response.end("<h1>hello</h1>");
		});

		const response = await client().fetch(`${base}/page`);
		expect(response.status).toBe(200);
		expect(response.body.toString()).toBe("<h1>hello</h1>");
		expect(response.headers["content-type"]).toBe("text/html");
	});

	it("sends our user agent and refuses to let a caller change it", async () => {
		let seen = "";
		const base = await serve((request, response) => {
			seen = String(request.headers["user-agent"]);
			response.end("ok");
		});

		await client().fetch(`${base}/`, {
			headers: { "user-agent": "definitely-not-a-bot" },
		});
		// Identifying the crawler is not a caller's preference to override.
		expect(seen).toContain("CheelaSearchBot");
	});

	it("decompresses gzip", async () => {
		const base = await serve((_request, response) => {
			response.writeHead(200, { "content-encoding": "gzip" });
			response.end(gzipSync(Buffer.from("<p>compressed</p>")));
		});

		const response = await client().fetch(`${base}/`);
		expect(response.body.toString()).toBe("<p>compressed</p>");
	});
});

describe("the address policy", () => {
	it("refuses loopback under the real classifier", async () => {
		const base = await serve((_request, response) => response.end("secret"));
		// Only the port rule is relaxed, so the address rule is the one on trial.
		const strict = createEgressClient(settings(), { allowPort: () => true });
		expect(await refusal(strict.fetch(base))).toBe("blocked-address");
	});

	it("refuses a port that is not 80 or 443", async () => {
		const base = await serve((_request, response) => response.end("ok"));
		const strict = createEgressClient(settings(), {
			classify: () => ({ allowed: true }) as const,
		});
		// A public host serving on 6379 is still Redis.
		expect(await refusal(strict.fetch(base))).toBe("port-not-allowed");
	});

	it("refuses schemes it does not speak", async () => {
		expect(await refusal(client().fetch("file:///etc/passwd"))).toBe(
			"scheme-not-allowed",
		);
		expect(await refusal(client().fetch("gopher://example.com/"))).toBe(
			"scheme-not-allowed",
		);
	});

	it("refuses a URL it cannot parse", async () => {
		expect(await refusal(client().fetch("not a url"))).toBe("invalid-url");
	});

	it("refuses a hostname that does not resolve", async () => {
		expect(
			await refusal(client().fetch("http://this-host-does-not-exist.invalid/")),
		).toBe("dns-failure");
	});
});

describe("redirects", () => {
	it("follows a same-host redirect", async () => {
		const base = await serve((request, response) => {
			if (request.url === "/start") {
				response.writeHead(302, { location: "/end" });
				response.end();
				return;
			}
			response.end("arrived");
		});

		const response = await client().fetch(`${base}/start`);
		expect(response.body.toString()).toBe("arrived");
		// The URL reported is where we ended up, not where we were sent.
		expect(response.url).toBe(`${base}/end`);
	});

	it("refuses to follow a redirect to another host", async () => {
		const base = await serve((_request, response) => {
			// The address check would catch this particular target too. The
			// same-host rule is the one that does not depend on catching each case.
			response.writeHead(302, { location: "http://169.254.169.254/token" });
			response.end();
		});

		expect(await refusal(client().fetch(base))).toBe("cross-host-redirect");
	});

	it("stops after the redirect limit", async () => {
		const base = await serve((_request, response) => {
			response.writeHead(302, { location: "/again" });
			response.end();
		});

		expect(await refusal(client({ maxRedirects: 2 }).fetch(base))).toBe(
			"too-many-redirects",
		);
	});
});

describe("size and time", () => {
	it("refuses a response that declares itself too large", async () => {
		const base = await serve((_request, response) => {
			response.writeHead(200, { "content-length": "999999" });
			response.end("x".repeat(999_999));
		});

		expect(await refusal(client({ maxBytes: 1000 }).fetch(base))).toBe(
			"response-too-large",
		);
	});

	it("refuses a response that lies about its length and streams too much", async () => {
		const base = await serve((_request, response) => {
			// No content-length at all, so the cap has to hold while streaming.
			response.writeHead(200, { "transfer-encoding": "chunked" });
			response.end("x".repeat(50_000));
		});

		expect(await refusal(client({ maxBytes: 1000 }).fetch(base))).toBe(
			"response-too-large",
		);
	});

	it("refuses a decompression bomb", async () => {
		// 5MB of zeros compresses to a few KB: small on the wire, and the wire
		// cap is exactly the check that cannot see it.
		const bomb = gzipSync(Buffer.alloc(5_000_000));
		const base = await serve((_request, response) => {
			response.writeHead(200, { "content-encoding": "gzip" });
			response.end(bomb);
		});

		expect(bomb.length).toBeLessThan(100_000);
		expect(await refusal(client({ maxBytes: 100_000 }).fetch(base))).toBe(
			"response-too-large",
		);
	});

	it("gives up on a server that never answers", async () => {
		const base = await serve(() => {
			// Deliberately never responds.
		});

		expect(await refusal(client({ timeoutMs: 300 }).fetch(base))).toBe(
			"timeout",
		);
	});

	it("stops when the caller aborts", async () => {
		const base = await serve(() => {});
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);

		expect(
			await refusal(client().fetch(base, { signal: controller.signal })),
		).toBe("timeout");
	});
});

describe("robots.txt", () => {
	async function withRobots(body: string, status = 200) {
		const base = await serve((request, response) => {
			if (request.url === "/robots.txt") {
				response.writeHead(status, { "content-type": "text/plain" });
				response.end(body);
				return;
			}
			response.end("page");
		});

		const bare = client();
		const withPolicy = createEgressClient(settings({ respectRobots: true }), {
			...local,
			robots: createRobotsPolicy(async (url) => {
				const response = await bare.fetchRaw(url);
				return { status: response.status, body: response.body };
			}),
		});
		return { base, withPolicy };
	}

	it("refuses a path the site disallows", async () => {
		const { base, withPolicy } = await withRobots(
			"User-agent: *\nDisallow: /private",
		);
		expect(
			await refusal(withPolicy.fetch(`${base}/private/x`, { crawl: true })),
		).toBe("robots-disallowed");
	});

	it("allows a path the site does not disallow", async () => {
		const { base, withPolicy } = await withRobots(
			"User-agent: *\nDisallow: /private",
		);
		const response = await withPolicy.fetch(`${base}/public`, { crawl: true });
		expect(response.body.toString()).toBe("page");
	});

	it("does not apply robots to calls that are not crawling", async () => {
		// An API we hold a key for is not a page we found. Nobody's robots.txt
		// is a statement about our own credentials.
		const { base, withPolicy } = await withRobots("User-agent: *\nDisallow: /");
		const response = await withPolicy.fetch(`${base}/api`);
		expect(response.status).toBe(200);
	});

	it("treats a missing robots.txt as permission", async () => {
		const { base, withPolicy } = await withRobots("", 404);
		const response = await withPolicy.fetch(`${base}/anything`, {
			crawl: true,
		});
		expect(response.status).toBe(200);
	});
});
