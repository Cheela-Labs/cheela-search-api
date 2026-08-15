import type { Pool } from "pg";

import { config } from "../../shared/config";
import { logger } from "../../shared/logger";
import { keyFor } from "../../shared/normalize";

/** A cached candidate — the two fields the pipeline reads before extraction. */
export type CachedCandidate = { url: string; title: string | null };

export interface QueryCache {
	/** What this query returned from this provider, if still fresh. */
	get(query: string, provider: string): Promise<CachedCandidate[] | null>;
	put(
		query: string,
		provider: string,
		candidates: readonly CachedCandidate[],
	): Promise<void>;
}

/**
 * The upstream result cache, over `web.query_cache`.
 *
 * **Short TTL, and the reason is in PLAN.md: "Rankings move."** This caches
 * which URLs an upstream vendor named for a query, and that answer is only
 * true for as long as their index says so. Too long a TTL does not just serve
 * stale results — it hides the vendor rotation entirely, so a provider going
 * bad stays invisible until the cache drains.
 *
 * Keyed by `(query_hash, provider)`, matching the table's primary key. Per
 * provider rather than per query alone, because two vendors answering the same
 * query are two different answers, and merging them under one key would serve
 * Tavily's results while claiming AnySearch produced them.
 *
 * Errors degrade to a miss, like every other cache here.
 */
export class PostgresQueryCache implements QueryCache {
	private readonly pool: Pool;
	private readonly ttlMs: number;

	constructor(pool: Pool, ttlMs: number = config.QUERY_CACHE_TTL_MS) {
		this.pool = pool;
		this.ttlMs = ttlMs;
	}

	async get(
		query: string,
		provider: string,
	): Promise<CachedCandidate[] | null> {
		try {
			const { hash } = keyFor(query);
			// Expiry is checked in SQL rather than compared in JS, so the database's
			// clock decides. Two instances with drifting clocks would otherwise
			// disagree about whether the same row is fresh.
			const { rows } = await this.pool.query<{
				result_urls: string[];
				result_titles: string[] | null;
			}>(
				`SELECT result_urls, result_titles
				   FROM web.query_cache
				  WHERE query_hash = $1 AND provider = $2 AND expires_at > now()`,
				[hash, provider],
			);

			const row = rows[0];
			if (!row) return null;

			// Titles are paired by index. A row written before the column existed,
			// or one whose arrays disagree, yields no titles rather than titles
			// attached to the wrong URLs — a missing title degrades to the domain,
			// a mismatched one is a lie about a source.
			const titles =
				row.result_titles && row.result_titles.length === row.result_urls.length
					? row.result_titles
					: null;

			// `""` back to null, and this is load-bearing rather than tidiness.
			// A null title is stored as an empty string because Postgres text[]
			// carries no convenient null, and the pipeline resolves a source title
			// as `extraction.title ?? candidate.title ?? domain` — where `??` falls
			// through on null but *not* on `""`. Returned raw, a titleless result
			// would render with a blank title instead of its domain.
			return row.result_urls.map((url, index) => ({
				url,
				title: titles?.[index] ? titles[index] : null,
			}));
		} catch (error) {
			logger.warn({ err: error, provider }, "Query cache read failed");
			return null;
		}
	}

	async put(
		query: string,
		provider: string,
		candidates: readonly CachedCandidate[],
	): Promise<void> {
		// An empty result is not cached. A vendor returning nothing is usually
		// having a bad minute rather than telling the truth about the web, and
		// caching it would serve that bad minute for the whole TTL.
		if (candidates.length === 0) return;

		try {
			const { normalized, hash } = keyFor(query);
			await this.pool.query(
				`INSERT INTO web.query_cache
				        (query_hash, normalized_query, provider, result_urls, result_titles,
				         fetched_at, expires_at)
				 VALUES ($1, $2, $3, $4, $5, now(), now() + ($6::bigint * interval '1 millisecond'))
				 ON CONFLICT (query_hash, provider) DO UPDATE
				    SET result_urls      = EXCLUDED.result_urls,
				        result_titles    = EXCLUDED.result_titles,
				        normalized_query = EXCLUDED.normalized_query,
				        fetched_at       = now(),
				        expires_at       = EXCLUDED.expires_at`,
				[
					hash,
					normalized,
					provider,
					candidates.map((c) => c.url),
					candidates.map((c) => c.title ?? ""),
					this.ttlMs,
				],
			);
		} catch (error) {
			logger.warn({ err: error, provider }, "Query cache write failed");
		}
	}
}
