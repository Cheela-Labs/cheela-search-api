import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { retrievePages } from "../../src/domain/retrieval/fetch";
import { classifyAddress } from "../../src/infra/egress/addresses";
import { createEgressClient } from "../../src/infra/egress/client";

/**
 * The behaviours step 4 of PLAN.md asks for: fetch in parallel, drop a slow
 * page rather than waiting on it, and never let one bad URL fail the stage.
 *
 * Against a real socket, through the real egress client — the interesting
 * failures here are timing and concurrency, and neither survives being mocked.
 */

const BASE = {
	timeoutMs: 1_500,
	maxBytes: 512 * 1024,
	maxRedirects: 2,
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

async function serve(
	handler: Parameters<typeof createServer>[1],
): Promise<number> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return (server.address() as AddressInfo).port;
}

function client(overrides: Partial<typeof BASE> = {}) {
	return createEgressClient(
		{ ...BASE, ...overrides },
		{
			resolve: async () => ["127.0.0.1"],
			classify: () => ({ allowed: true }) as const,
			allowPort: () => true,
		},
	);
}

const article = (marker: string) =>
	`<html><head><title>${marker}</title></head><body><article><h1>${marker}</h1><p>${marker}. ${"Body sentence long enough to clear the minimum length. ".repeat(8)}</p></article></body></html>`;

describe("retrievePages", () => {
	it("extracts every page that answers", async () => {
		const port = await serve((request, response) => {
			response.writeHead(200, { "content-type": "text/html" });
			response.end(article(`PAGE${request.url}`));
		});

		const { outcomes, stats } = await retrievePages(
			[`http://a.invalid:${port}/1`, `http://a.invalid:${port}/2`],
			{ client: client() },
		);

		expect(stats.extracted).toBe(2);
		expect(stats.successRate).toBe(1);
		expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
	});

	it("drops a slow page without delaying the others", async () => {
		const port = await serve((request, response) => {
			if (request.url === "/slow") {
				// Never answers. The per-request deadline in the egress client is
				// what ends this, not anything in retrievePages.
				return;
			}
			response.writeHead(200, { "content-type": "text/html" });
			response.end(article("FAST"));
		});

		const started = Date.now();
		const { stats, outcomes } = await retrievePages(
			[
				`http://a.invalid:${port}/slow`,
				`http://a.invalid:${port}/1`,
				`http://a.invalid:${port}/2`,
			],
			{ client: client({ timeoutMs: 400 }), concurrency: 3 },
		);
		const elapsed = Date.now() - started;

		expect(stats.extracted).toBe(2);
		expect(stats.failures.timeout).toBe(1);
		// The fast pages did not queue behind the slow one.
		expect(elapsed).toBeLessThan(1_200);
		expect(outcomes[0]?.ok).toBe(false);
	});

	it("never throws, whatever the URLs do", async () => {
		const port = await serve((_request, response) => {
			response.writeHead(500);
			response.end("nope");
		});

		const { stats } = await retrievePages(
			[
				`http://a.invalid:${port}/`,
				"http://169.254.169.254/latest/meta-data/",
				"not a url at all",
				"file:///etc/passwd",
			],
			{
				// The real address policy for everything except the fixture host —
				// the metadata URL has to be refused as an *address*, not merely
				// fail to connect, and a blanket-permissive classifier would prove
				// nothing about it. `169.254.169.254` is a literal, so it is judged
				// directly without going through the stub resolver.
				client: createEgressClient(BASE, {
					resolve: async () => ["127.0.0.1"],
					classify: (address) =>
						address === "127.0.0.1"
							? ({ allowed: true } as const)
							: classifyAddress(address),
					allowPort: () => true,
				}),
			},
		);

		expect(stats.extracted).toBe(0);
		expect(stats.requested).toBe(4);
		expect(Object.keys(stats.failures).sort()).toEqual(
			[
				"blocked-address",
				// The fixture answers 500, so this is theirs and transient —
				// distinct from a 404, which would indict the URL we were given.
				"server-error",
				"invalid-url",
				"scheme-not-allowed",
			].sort(),
		);
	});

	it("counts an HTTP error apart from an extraction failure", async () => {
		// The distinction matters: a corpus full of `not-found` indicts the
		// upstream provider's URLs, one full of `javascript-shell` indicts the
		// extractor.
		const port = await serve((request, response) => {
			if (request.url === "/gone") {
				response.writeHead(404);
				response.end();
				return;
			}
			response.writeHead(200, { "content-type": "text/html" });
			response.end(
				'<html><body><div id="root"></div><script src="/a.js"></script></body></html>',
			);
		});

		const { stats } = await retrievePages(
			[`http://a.invalid:${port}/gone`, `http://a.invalid:${port}/spa`],
			{ client: client() },
		);

		expect(stats.failures["not-found"]).toBe(1);
		expect(stats.failures["javascript-shell"]).toBe(1);
	});

	/**
	 * The four kinds of HTTP failure, which were one bucket.
	 *
	 * They have different owners: a 403 is a site declining to serve an
	 * identified bot and PLAN.md refuses to spoof around it, a 404 is the
	 * upstream provider handing us a stale URL, a 429 is ours, and a 503 is
	 * theirs and transient. One name for all four made 40% of the eval
	 * harness's failures unreadable.
	 */
	it("names an HTTP failure by cause, not by number", async () => {
		const port = await serve((request, response) => {
			const status = Number(request.url?.slice(1) ?? "500");
			response.writeHead(status);
			response.end();
		});

		const { stats } = await retrievePages(
			[
				`http://a.invalid:${port}/403`,
				`http://a.invalid:${port}/404`,
				`http://a.invalid:${port}/429`,
				`http://a.invalid:${port}/503`,
			],
			{ client: client() },
		);

		expect(stats.failures["refused-by-site"]).toBe(1);
		expect(stats.failures["not-found"]).toBe(1);
		expect(stats.failures["rate-limited"]).toBe(1);
		expect(stats.failures["server-error"]).toBe(1);
	});

	it("fetches a repeated URL once", async () => {
		let hits = 0;
		const port = await serve((_request, response) => {
			hits += 1;
			response.writeHead(200, { "content-type": "text/html" });
			response.end(article("ONCE"));
		});

		const { stats } = await retrievePages(
			[
				`http://a.invalid:${port}/same`,
				`http://a.invalid:${port}/same`,
				`http://a.invalid:${port}/same`,
			],
			{ client: client() },
		);

		expect(hits).toBe(1);
		// And it contributes one passage to the answer, not three.
		expect(stats.requested).toBe(1);
		expect(stats.extracted).toBe(1);
	});

	it("holds concurrency to the limit it was given", async () => {
		let inFlight = 0;
		let peak = 0;
		const port = await serve((_request, response) => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			setTimeout(() => {
				inFlight -= 1;
				response.writeHead(200, { "content-type": "text/html" });
				response.end(article("SLOWISH"));
			}, 60);
		});

		const urls = Array.from(
			{ length: 8 },
			(_, index) => `http://a.invalid:${port}/${index}`,
		);
		const { stats } = await retrievePages(urls, {
			client: client(),
			concurrency: 2,
		});

		expect(stats.extracted).toBe(8);
		// A burst of sockets at one host is how a crawler earns a block.
		expect(peak).toBeLessThanOrEqual(2);
	});

	it("reports the host as the capability-plane join key", async () => {
		const port = await serve((_request, response) => {
			response.writeHead(200, { "content-type": "text/html" });
			response.end(article("HOST"));
		});

		const { outcomes } = await retrievePages(
			[`http://docs.example.invalid:${port}/x`],
			{ client: client() },
		);

		const [outcome] = outcomes;
		expect(outcome?.ok).toBe(true);
		// Host, not eTLD+1: docs.example.com and example.com publish separate
		// manifests, so collapsing them would merge two different declarations.
		if (outcome?.ok) expect(outcome.page.domain).toBe("docs.example.invalid");
	});

	it("returns zeroed stats for no URLs rather than dividing by zero", async () => {
		const { stats } = await retrievePages([], { client: client() });
		expect(stats).toMatchObject({ requested: 0, extracted: 0, successRate: 0 });
	});
});
