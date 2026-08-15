import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { retrievePages } from "../src/domain/retrieval/fetch";
import type {
	CachedDocument,
	DocumentStore,
	PutDocument,
} from "../src/infra/db/document-store";
import type { CachedCandidate, QueryCache } from "../src/infra/db/query-cache";
import { createEgressClient } from "../src/infra/egress/client";
import { withQueryCache } from "../src/infra/upstream/cached-rotation";
import type { RotationResult } from "../src/infra/upstream/rotation";
import { logger } from "../src/shared/logger";
import {
	cacheStats,
	recordHit,
	recordMiss,
	recordRevalidated,
	resetCacheStats,
} from "../src/shared/metrics";
import { keyFor, normalizeQuery } from "../src/shared/normalize";

/**
 * Step 7 of PLAN.md — the caches, and the hit rate that justifies them.
 *
 * Every assertion here is about a failure that would be *invisible in
 * production*: a cache that silently serves a degraded page, a hit rate that
 * counts the wrong thing, a stale entry that hides a failing vendor. A cache
 * whose bugs announce themselves is not the dangerous kind.
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

beforeEach(() => {
	resetCacheStats();
});

async function serve(
	handler: Parameters<typeof createServer>[1],
): Promise<number> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return (server.address() as AddressInfo).port;
}

/**
 * Loopback is refused by the real address policy, correctly — so these tests
 * override it, exactly as `test/retrieval/fetch.test.ts` does. What is under
 * test here is caching, not the egress rules, which have their own 82 tests.
 */
function client() {
	return createEgressClient(BASE, {
		resolve: async () => ["127.0.0.1"],
		classify: () => ({ allowed: true }) as const,
		allowPort: () => true,
	});
}

const PAGE = `<!doctype html><html><head><title>Cached Title</title>
<meta property="og:image" content="https://example.com/card.png">
</head><body><article>${"An extracted sentence about the subject. ".repeat(40)}</article></body></html>`;

function documentFor(url: string, overrides: Partial<CachedDocument> = {}) {
	return {
		url,
		canonicalUrl: url,
		domain: "127.0.0.1",
		status: 200,
		etag: null,
		fresh: true,
		extraction: {
			title: "Cached Title",
			canonicalUrl: url,
			image: "https://example.com/card.png",
			text: "An extracted sentence about the subject. ".repeat(40),
			publishedAt: null,
			contentHash: "hash-1",
		},
		...overrides,
	} satisfies CachedDocument;
}

/** A store that records what it was asked, so the test can assert on traffic. */
function fakeStore(seed?: CachedDocument | null) {
	const writes: PutDocument[] = [];
	const touched: string[] = [];
	let current = seed ?? null;

	const store: DocumentStore = {
		async get() {
			return current;
		},
		async put(input) {
			writes.push(input);
		},
		async touch(canonicalUrl) {
			touched.push(canonicalUrl);
		},
	};

	return {
		store,
		writes,
		touched,
		set(next: CachedDocument | null) {
			current = next;
		},
	};
}

describe("content cache", () => {
	it("serves a fresh page without touching the network", async () => {
		let requests = 0;
		const port = await serve((_req, res) => {
			requests += 1;
			res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
		});
		const url = `http://127.0.0.1:${port}/a`;
		const cache = fakeStore(documentFor(url));

		const { outcomes } = await retrievePages([url], {
			client: client(),
			cache: cache.store,
		});

		// The whole point: no request was made at all.
		expect(requests).toBe(0);
		expect(outcomes[0].ok).toBe(true);
		expect(cacheStats().content.hits).toBe(1);
	});

	/**
	 * The regression that would look like an improvement.
	 *
	 * A cached page must carry everything a freshly fetched one does. If the
	 * cache drops `image`, discovery answers lose their cards *only* on a hit —
	 * so the feature works when the cache is cold and degrades as it warms,
	 * which is the hardest shape of bug to attribute.
	 */
	it("returns the same fields a fetch would, image included", async () => {
		const port = await serve((_req, res) =>
			res.writeHead(200, { "content-type": "text/html" }).end(PAGE),
		);
		const url = `http://127.0.0.1:${port}/a`;

		const fresh = await retrievePages([url], { client: client() });
		const cached = await retrievePages([url], {
			client: client(),
			cache: fakeStore(documentFor(url)).store,
		});

		const a = fresh.outcomes[0];
		const b = cached.outcomes[0];
		expect(a.ok && b.ok).toBe(true);
		if (!a.ok || !b.ok) return;

		expect(b.page.extraction.image).toBe(a.page.extraction.image);
		expect(b.page.extraction.title).toBe(a.page.extraction.title);
		expect(b.page.domain).toBe(a.page.domain);
	});

	it("revalidates a stale page and serves it back on 304", async () => {
		let seenIfNoneMatch: string | undefined;
		const port = await serve((req, res) => {
			seenIfNoneMatch = req.headers["if-none-match"] as string | undefined;
			res.writeHead(304).end();
		});
		const url = `http://127.0.0.1:${port}/a`;
		const cache = fakeStore(
			documentFor(url, { fresh: false, etag: '"abc123"' }),
		);

		const { outcomes } = await retrievePages([url], {
			client: client(),
			cache: cache.store,
		});

		expect(seenIfNoneMatch).toBe('"abc123"');
		expect(outcomes[0].ok).toBe(true);
		// Expiry pushed out rather than the row rewritten — a 304 carries no body
		// to rewrite it with.
		expect(cache.touched).toEqual([url]);
		expect(cache.writes).toHaveLength(0);
		// Counted apart from a plain hit: it cost a round trip, and no bandwidth.
		expect(cacheStats().content.revalidated).toBe(1);
		expect(cacheStats().content.hits).toBe(0);
	});

	it("writes through on a miss, carrying the etag for next time", async () => {
		const port = await serve((_req, res) =>
			res
				.writeHead(200, { "content-type": "text/html", etag: '"v1"' })
				.end(PAGE),
		);
		const url = `http://127.0.0.1:${port}/a`;
		const cache = fakeStore(null);

		await retrievePages([url], { client: client(), cache: cache.store });

		expect(cache.writes).toHaveLength(1);
		expect(cache.writes[0].etag).toBe('"v1"');
		expect(cache.writes[0].extraction.title).toBe("Cached Title");
		expect(cacheStats().content.misses).toBe(1);
	});

	/** The cache is an optimisation. Without one, nothing changes. */
	it("fetches normally when no cache is configured", async () => {
		let requests = 0;
		const port = await serve((_req, res) => {
			requests += 1;
			res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
		});

		const { outcomes } = await retrievePages([`http://127.0.0.1:${port}/a`], {
			client: client(),
		});

		expect(requests).toBe(1);
		expect(outcomes[0].ok).toBe(true);
	});
});

function fakeQueryCache(seed: Record<string, CachedCandidate[]> = {}) {
	const store = new Map<string, CachedCandidate[]>(Object.entries(seed));
	const writes: { provider: string; candidates: CachedCandidate[] }[] = [];

	const cache: QueryCache = {
		async get(query, provider) {
			return store.get(`${normalizeQuery(query)}::${provider}`) ?? null;
		},
		async put(query, provider, candidates) {
			writes.push({ provider, candidates: [...candidates] });
			store.set(`${normalizeQuery(query)}::${provider}`, [...candidates]);
		},
	};

	return { cache, writes };
}

function fakeRotation(result: RotationResult, names = ["tavily", "anysearch"]) {
	let calls = 0;
	return {
		rotation: {
			get names() {
				return names;
			},
			async search() {
				calls += 1;
				return result;
			},
		},
		get calls() {
			return calls;
		},
	};
}

const ANSWER: RotationResult = {
	provider: "tavily",
	failures: [],
	candidates: [
		{ url: "https://a.example/1", title: "First", rank: 1, provider: "tavily" },
		{ url: "https://b.example/2", title: null, rank: 2, provider: "tavily" },
	],
};

describe("query cache", () => {
	it("answers from cache without calling a vendor", async () => {
		const { cache } = fakeQueryCache({
			"best laptop::tavily": [{ url: "https://a.example/1", title: "First" }],
		});
		const upstream = fakeRotation(ANSWER);

		const result = await withQueryCache(upstream.rotation, cache).search(
			"  Best   LAPTOP? ",
		);

		// Normalised, so the padded, capitalised, punctuated form hits the same row.
		expect(upstream.calls).toBe(0);
		expect(result.provider).toBe("tavily");
		expect(result.candidates[0].url).toBe("https://a.example/1");
		expect(cacheStats().query.hits).toBe(1);
	});

	it("stores a real answer and reuses it", async () => {
		const { cache, writes } = fakeQueryCache();
		const upstream = fakeRotation(ANSWER);
		const cached = withQueryCache(upstream.rotation, cache);

		await cached.search("agent discovery");
		await cached.search("agent discovery");

		expect(upstream.calls).toBe(1);
		expect(writes).toHaveLength(1);
		expect(writes[0].provider).toBe("tavily");
	});

	/**
	 * A failed sweep must not be cached.
	 *
	 * Storing `provider: null` would turn one bad minute into a TTL-long outage
	 * that a healthy vendor could not rescue — the cache would keep answering
	 * "nobody could search" long after somebody could.
	 */
	it("does not cache a result no provider produced", async () => {
		const { cache, writes } = fakeQueryCache();
		const upstream = fakeRotation({
			provider: null,
			candidates: [],
			failures: [{ provider: "tavily", detail: "boom" }],
		});

		await withQueryCache(upstream.rotation, cache).search("anything");

		expect(writes).toHaveLength(0);
	});

	/** Nothing failed on a hit, so the failures list must not claim otherwise. */
	it("reports no failures on a cache hit", async () => {
		const { cache } = fakeQueryCache({
			"q::tavily": [{ url: "https://a.example/1", title: null }],
		});
		const result = await withQueryCache(
			fakeRotation({ ...ANSWER, failures: [{ provider: "x", detail: "y" }] })
				.rotation,
			cache,
		).search("q");

		expect(result.failures).toEqual([]);
	});

	it("regenerates rank from stored order", async () => {
		const { cache } = fakeQueryCache({
			"q::tavily": [
				{ url: "https://a.example/1", title: null },
				{ url: "https://b.example/2", title: null },
			],
		});

		const result = await withQueryCache(
			fakeRotation(ANSWER).rotation,
			cache,
		).search("q");

		expect(result.candidates.map((c) => c.rank)).toEqual([1, 2]);
	});
});

describe("query normalization", () => {
	it("folds case, whitespace and trailing punctuation into one key", () => {
		const a = keyFor("  What is   ADS? ");
		const b = keyFor("what is ads");
		expect(a.normalized).toBe("what is ads");
		expect(a.hash).toBe(b.hash);
	});

	/**
	 * Interior punctuation is data, not noise.
	 *
	 * Stripping it would fold `node.js` into `nodejs` and `C++` into `c`, which
	 * are different queries returning different pages — normalising must change
	 * how a query was typed, never what it asked.
	 */
	it("keeps punctuation inside a term", () => {
		expect(normalizeQuery("node.js streams")).toBe("node.js streams");
		expect(normalizeQuery("C++ move semantics")).toBe("c++ move semantics");
		expect(normalizeQuery("AT&T coverage")).toBe("at&t coverage");
	});
});

describe("cache stats", () => {
	it("reports no hit rate before anything is looked up", () => {
		expect(cacheStats().content.hitRate).toBeNull();
	});

	/**
	 * A revalidated document counts toward the hit rate.
	 *
	 * It cost a round trip but no bandwidth, no extraction and no re-chunking —
	 * which is most of what the cache exists to save. Counting it as a miss
	 * would understate the cache against the >0.55 gate PLAN.md sets.
	 */
	it("counts a revalidation as a hit for rate purposes, and reports it apart", () => {
		resetCacheStats();
		const stats = () => cacheStats().content;

		// 1 hit, 1 revalidated, 2 misses → (1+1)/4
		recordHit("content");
		recordRevalidated("content");
		recordMiss("content");
		recordMiss("content");

		expect(stats().hitRate).toBeCloseTo(0.5);
		expect(stats().revalidated).toBe(1);
		expect(stats().hits).toBe(1);
	});
});

/**
 * The line `monitoring/cache-lookup-metric.yaml` reads.
 *
 * This is a wire contract that TypeScript cannot check, because the other end
 * is a YAML file in another system: the metric's `labelExtractors` name
 * `jsonPayload.cache` and `jsonPayload.outcome`, and its filter matches
 * `jsonPayload.metric="cache_lookup"`. Rename any of the three here and
 * nothing fails — the metric simply matches nothing and the dashboard reports
 * a confident, empty zero, which is the worst way for a gate to break.
 *
 * The same argument `test/app.test.ts` makes for asserting the event encoding
 * rather than the types, applied to the one field name that leaves the process.
 *
 * Asserted on the object handed to the logger rather than on stdout: pino
 * writes to file descriptor 1 directly, so intercepting `process.stdout.write`
 * would capture nothing and pass for the wrong reason.
 */
describe("the cache-lookup log line", () => {
	function fieldsFrom(run: () => void): Record<string, unknown> {
		const spy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
		try {
			run();
			const call = spy.mock.calls.at(-1);
			return (call?.[0] ?? {}) as Record<string, unknown>;
		} finally {
			spy.mockRestore();
		}
	}

	it("carries the discriminator and both labels the metric extracts", () => {
		expect(fieldsFrom(() => recordHit("content"))).toMatchObject({
			metric: "cache_lookup",
			cache: "content",
			outcome: "hit",
		});
	});

	it("spells each outcome the way the dashboard groups them", () => {
		expect(fieldsFrom(() => recordMiss("query")).outcome).toBe("miss");
		expect(fieldsFrom(() => recordRevalidated("content")).outcome).toBe(
			"revalidated",
		);
		expect(fieldsFrom(() => recordMiss("query")).cache).toBe("query");
	});

	/**
	 * The privacy property, asserted rather than trusted.
	 *
	 * `/health` reports these counts *outside* the token gate, justified on the
	 * grounds that they "name no query, no URL and no caller, so there is
	 * nothing here to protect". Emitting the same decisions to a log is only
	 * safe while that stays true, and the tempting next commit is the one that
	 * adds the URL "just for debugging" — at which point every fetched address
	 * is in Cloud Logging forever, next to a query log PLAN.md deliberately
	 * keeps unlinked from any identity.
	 *
	 * An exact key set, so adding a field is a decision somebody has to make
	 * here on purpose.
	 */
	it("names no query, no url and no caller", () => {
		expect(Object.keys(fieldsFrom(() => recordHit("content"))).sort()).toEqual([
			"cache",
			"metric",
			"outcome",
		]);
	});
});

/**
 * Forced revalidation — the router's freshness verdict reaching the cache.
 *
 * The whole design claim is that this is *revalidation* and not a bypass. A
 * bypass would re-download and re-extract every page on every volatile query;
 * forcing the conditional request means an unchanged page answers 304, which
 * costs a round trip and no body, no extraction and no re-chunking.
 */
describe("content cache · revalidate", () => {
	it("re-checks a page that is still fresh, instead of serving it blind", async () => {
		let requests = 0;
		let seenIfNoneMatch: string | undefined;
		const port = await serve((req, res) => {
			requests += 1;
			seenIfNoneMatch = req.headers["if-none-match"] as string | undefined;
			res.writeHead(304).end();
		});
		const url = `http://127.0.0.1:${port}/a`;
		// Fresh: without `revalidate` this is served with no request at all.
		const cache = fakeStore(documentFor(url, { etag: '"v1"' }));

		const { outcomes } = await retrievePages([url], {
			client: client(),
			cache: cache.store,
			revalidate: true,
		});

		expect(requests).toBe(1);
		expect(seenIfNoneMatch).toBe('"v1"');
		expect(outcomes[0].ok).toBe(true);
		// The point of the design: unchanged means we still serve what we held,
		// and it is counted as a revalidation rather than as a hit or a miss.
		expect(cacheStats().content.revalidated).toBe(1);
		expect(cacheStats().content.hits).toBe(0);
		expect(cache.writes).toHaveLength(0);
	});

	it("serves the fresh copy without a request when revalidate is off", async () => {
		let requests = 0;
		const port = await serve((_req, res) => {
			requests += 1;
			res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
		});
		const url = `http://127.0.0.1:${port}/a`;
		const cache = fakeStore(documentFor(url, { etag: '"v1"' }));

		await retrievePages([url], { client: client(), cache: cache.store });

		expect(requests).toBe(0);
		expect(cacheStats().content.hits).toBe(1);
	});

	it("takes the new body when the page actually changed", async () => {
		const port = await serve((_req, res) =>
			res
				.writeHead(200, { "content-type": "text/html", etag: '"v2"' })
				.end(PAGE),
		);
		const url = `http://127.0.0.1:${port}/a`;
		const cache = fakeStore(documentFor(url, { etag: '"v1"' }));

		const { outcomes } = await retrievePages([url], {
			client: client(),
			cache: cache.store,
			revalidate: true,
		});

		expect(outcomes[0].ok).toBe(true);
		// Rewritten, with the new etag — this is the case worth paying for.
		expect(cache.writes).toHaveLength(1);
		expect(cache.writes[0].etag).toBe('"v2"');
		expect(cacheStats().content.misses).toBe(1);
	});

	/**
	 * A cached copy with no etag has nothing to make the request conditional
	 * with. Degrading to an ordinary fetch is correct — no etag means the origin
	 * gave us no way to ask cheaply — and is asserted so that it stays a
	 * deliberate degradation rather than becoming a silent 200-on-every-query.
	 */
	it("falls back to a full fetch when there is no etag to ask with", async () => {
		let seenIfNoneMatch: string | undefined = "unset";
		const port = await serve((req, res) => {
			seenIfNoneMatch = req.headers["if-none-match"] as string | undefined;
			res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
		});
		const url = `http://127.0.0.1:${port}/a`;
		const cache = fakeStore(documentFor(url, { etag: null }));

		const { outcomes } = await retrievePages([url], {
			client: client(),
			cache: cache.store,
			revalidate: true,
		});

		expect(seenIfNoneMatch).toBeUndefined();
		expect(outcomes[0].ok).toBe(true);
	});
});
