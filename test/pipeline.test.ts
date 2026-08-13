import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { extractiveComposer } from "../src/domain/compose/extractive";
import type { Composer } from "../src/domain/compose/types";
import { createEgressClient } from "../src/infra/egress/client";
import { createRotation } from "../src/infra/upstream/rotation";
import {
	normaliseCandidates,
	UpstreamError,
} from "../src/infra/upstream/types";
import type { SearchEvent } from "../src/shared/events";

/**
 * The whole pipeline, end to end, over a real socket.
 *
 * Step 6's acceptance in PLAN.md is `apps/search-web` rendering a streamed
 * answer against this service — which needs a vendor key. This is as close as
 * that gets without one: a stub upstream returns URLs, a fixture server serves
 * real HTML at them, and everything between is the production code path —
 * egress with its policy, Readability extraction, chunking, BM25, composition,
 * and the SSE encoding the surface parses.
 *
 * What it asserts hardest is the *ordering*, because that is the part of the
 * contract the surface cannot recover if this gets it wrong.
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

const article = (marker: string, subject: string) =>
	`<html><head><title>${marker}</title></head><body>
		<nav>Home Pricing Docs</nav>
		<article><h1>${marker}</h1>
		<p>${subject} ${"Body sentence with enough length to clear the extractor's minimum and the chunker's floor. ".repeat(8)}</p>
		</article>
		<footer>Copyright boilerplate</footer></body></html>`;

async function serveArticles(pages: Record<string, string>): Promise<number> {
	const server = createServer((request, response) => {
		const body = pages[request.url ?? ""];
		if (!body) {
			response.writeHead(404);
			response.end();
			return;
		}
		response.writeHead(200, { "content-type": "text/html" });
		response.end(body);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return (server.address() as AddressInfo).port;
}

const loopbackEgress = () =>
	createEgressClient(
		{
			timeoutMs: 2_000,
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

const stubUpstream = (urls: string[]) =>
	createRotation([
		{
			name: "stub",
			async search(_query, options) {
				return normaliseCandidates(
					urls.map((url) => ({ url })),
					"stub",
					options?.limit ?? 10,
				);
			},
		},
	]);

/** Reads the whole SSE stream into the events the surface would see. */
async function collect(response: Response): Promise<SearchEvent[]> {
	const body = await response.text();
	return body
		.split("\n\n")
		.filter((chunk) => chunk.startsWith("data:"))
		.map((chunk) => JSON.parse(chunk.slice(5).trim()) as SearchEvent);
}

describe("pipeline · end to end", () => {
	it("streams a cited answer from pages it actually fetched", async () => {
		const port = await serveArticles({
			"/a": article("Alpha", "Cloudflare Workers have no cold start."),
			"/b": article("Beta", "Fargate bills per second after a slow start."),
		});

		const app = createApp({
			upstream: stubUpstream([
				`http://a.invalid:${port}/a`,
				`http://b.invalid:${port}/b`,
			]),
			egress: loopbackEgress(),
			composer: extractiveComposer,
		});

		const events = await collect(await app.request("/search?q=cold%20start"));
		const types = events.map((event) => event.type);

		expect(types).toContain("source");
		expect(types).toContain("block");
		expect(types.at(-1)).toBe("done");

		// The load-bearing ordering: every source is emitted before the first
		// answer block. The surface builds its rail from these while the answer
		// is still being composed, and a pipeline that batches loses that.
		expect(types.lastIndexOf("source")).toBeLessThan(types.indexOf("block"));

		const sources = events.flatMap((event) =>
			event.type === "source" ? [event.source] : [],
		);
		expect(sources).toHaveLength(2);
		// Numbered from 1, in ranking order, which is what citations refer to.
		expect(sources.map((source) => source.n)).toEqual([1, 2]);
		for (const source of sources) {
			expect(source.passages.length).toBeGreaterThan(0);
			expect(source.swatch).toMatch(/^hsl\(/);
			// Extraction ran: the nav and footer are gone from the passages.
			expect(source.passages[0]?.text).not.toContain("Copyright boilerplate");
		}
	});

	it("reports a page that would not load without failing the query", async () => {
		const port = await serveArticles({
			"/good": article("Good", "Workers scale to zero."),
		});

		const app = createApp({
			upstream: stubUpstream([
				`http://a.invalid:${port}/good`,
				`http://a.invalid:${port}/missing`,
			]),
			egress: loopbackEgress(),
			composer: extractiveComposer,
		});

		const events = await collect(await app.request("/search?q=workers"));

		// One page 404s. The query still answers from the other — asking several
		// sources is the whole point of asking several sources.
		expect(events.map((e) => e.type)).toContain("block");
		const read = events.find(
			(event) => event.type === "stage" && event.stage.id === "read",
		);
		expect(read).toBeDefined();
	});

	it("emits an error event, never a bare status, when every provider fails", async () => {
		const app = createApp({
			upstream: createRotation([
				{
					name: "down",
					async search() {
						throw new UpstreamError("down", "HTTP 503", 503);
					},
				},
			]),
			egress: loopbackEgress(),
			composer: extractiveComposer,
		});

		const response = await app.request("/search?q=anything");
		// The stream has already begun by the time this is known; there is no
		// status code left to send.
		expect(response.status).toBe(200);

		const events = await collect(response);
		const error = events.find((event) => event.type === "error");
		expect(error).toBeDefined();
		if (error?.type === "error") expect(error.message).toContain("503");
	});

	it("finishes cleanly when the upstream found nothing", async () => {
		const app = createApp({
			upstream: stubUpstream([]),
			egress: loopbackEgress(),
			composer: extractiveComposer,
		});

		const events = await collect(await app.request("/search?q=nothing"));
		const types = events.map((event) => event.type);

		// "Nothing matched" is an answer, not a failure — no error frame.
		expect(types).not.toContain("error");
		expect(types.at(-1)).toBe("done");
		expect(events.find((e) => e.type === "crawled")).toMatchObject({
			count: 0,
		});
	});

	it("passes the composer's blocks through in the order it yields them", async () => {
		const port = await serveArticles({
			"/a": article("Alpha", "Workers have no cold start."),
		});

		const ordered: Composer = {
			name: "ordered",
			async *compose() {
				yield {
					kind: "answer",
					id: "answer",
					spans: [{ kind: "text", text: "First." }],
				};
				yield {
					kind: "note",
					id: "why",
					label: "WHY",
					spans: [
						{ kind: "text", text: "Second." },
						{ kind: "cite", n: 1 },
					],
				};
			},
		};

		const app = createApp({
			upstream: stubUpstream([`http://a.invalid:${port}/a`]),
			egress: loopbackEgress(),
			composer: ordered,
		});

		const events = await collect(await app.request("/search?q=x"));
		const blocks = events.flatMap((event) =>
			event.type === "block" ? [event.block] : [],
		);

		expect(blocks.map((block) => block.id)).toEqual(["answer", "why"]);
	});

	it("still rejects an empty query before opening a stream", async () => {
		const app = createApp({ upstream: stubUpstream([]) });
		const response = await app.request("/search?q=%20%20");
		expect(response.status).toBe(400);
		expect(response.headers.get("content-type")).toContain("application/json");
	});
});

/**
 * Discovery, which is the one intent where the pages worth showing are the ones
 * we cannot read.
 *
 * The shell fixture below is the case that motivated `places` existing at all: a
 * storefront that renders its catalogue in JavaScript extracts to nothing, so it
 * never becomes a source, and a "where to buy" row built from sources would be
 * empty on exactly the queries it is for. Its `<head>` is intact throughout.
 */
describe("pipeline · discovery", () => {
	const shell = (title: string, image: string) =>
		`<html><head><title>${title}</title>
			<meta property="og:title" content="${title}">
			<meta property="og:image" content="${image}"></head>
			<body><div id="root"></div><script>window.__DATA__={}</script></body></html>`;

	/** Answers one set of URLs for the user's query and another for the rewrite. */
	const twoQueryUpstream = (byQuery: Record<string, string[]>) =>
		createRotation([
			{
				name: "stub",
				async search(query, options) {
					return normaliseCandidates(
						(byQuery[query] ?? []).map((url) => ({ url })),
						"stub",
						options?.limit ?? 10,
					);
				},
			},
		]);

	const discovering = (retrievalQuery: string | null) => async () => ({
		intent: "discovery" as const,
		retrievalQuery,
	});

	it("shows a shop it could not read, using the head it could", async () => {
		const port = await serveArticles({
			"/wiki": article("Encyclopedia", "The sneaker was released in 1985."),
			"/shop": shell("Buy Jordans", "https://cdn.test/shoe.jpg"),
		});

		const app = createApp({
			upstream: twoQueryUpstream({
				jordans: [`http://wiki.invalid:${port}/wiki`],
				"buy jordans online": [`http://shop.invalid:${port}/shop`],
			}),
			egress: loopbackEgress(),
			composer: extractiveComposer,
			classifier: discovering("buy jordans online"),
		});

		const events = await collect(await app.request("/search?q=jordans"));
		const places = events.flatMap((event) =>
			event.type === "places" ? event.places : [],
		);
		const sources = events.flatMap((event) =>
			event.type === "source" ? [event.source] : [],
		);

		// The shop is a place and is emphatically not a source: nothing extracted
		// from it, so nothing may cite it.
		expect(places.map((place) => place.domain)).toContain("shop.invalid");
		expect(sources.map((source) => source.domain)).not.toContain(
			"shop.invalid",
		);

		const shop = places.find((place) => place.domain === "shop.invalid");
		expect(shop?.image).toBe("https://cdn.test/shoe.jpg");
		expect(shop?.title).toBe("Buy Jordans");
	});

	it("leads with the search that went looking for places", async () => {
		const port = await serveArticles({
			"/wiki": article("Encyclopedia", "The sneaker was released in 1985."),
			"/shop": shell("Buy Jordans", "https://cdn.test/shoe.jpg"),
		});

		const app = createApp({
			upstream: twoQueryUpstream({
				jordans: [`http://wiki.invalid:${port}/wiki`],
				"buy jordans online": [`http://shop.invalid:${port}/shop`],
			}),
			egress: loopbackEgress(),
			composer: extractiveComposer,
			classifier: discovering("buy jordans online"),
		});

		const events = await collect(await app.request("/search?q=jordans"));
		const places = events.flatMap((event) =>
			event.type === "places" ? event.places : [],
		);

		// Both have an image, so a picture-first sort would be a coin toss. The
		// shop must win because it came from the query that asked for shops.
		expect(places[0]?.domain).toBe("shop.invalid");
	});

	it("emits no places for an ordinary question", async () => {
		const port = await serveArticles({
			"/a": article("Alpha", "Cloudflare Workers have no cold start."),
		});

		const app = createApp({
			upstream: stubUpstream([`http://a.invalid:${port}/a`]),
			egress: loopbackEgress(),
			composer: extractiveComposer,
			classifier: async () => ({
				intent: "informational" as const,
				retrievalQuery: null,
			}),
		});

		const events = await collect(await app.request("/search?q=cold%20start"));
		expect(events.map((event) => event.type)).not.toContain("places");
	});
});
