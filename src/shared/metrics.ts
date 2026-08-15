import { logger } from "./logger";

/**
 * Cache counters, in process — and one log line per decision, for the
 * collector.
 *
 * PLAN.md gates step 7 on "hit rate is on a dashboard, from the first day it
 * can be", and argues why: **cache hit rate decides unit economics outright at
 * MVP**, because the dominant cost per query is upstream calls and page
 * fetches. A cache with no hit rate is a cache nobody can defend.
 *
 * ## Why the process reports decisions instead of totals
 *
 * The counters below are per instance and reset when the container is
 * replaced, which is what stopped step 7 being accepted: a scale-to-zero
 * service spends most of its life having just forgotten everything it knew, so
 * `/health` can never be the dashboard number. Each decision is therefore also
 * emitted as a structured line and Cloud Monitoring counts them. That is this
 * file's own stated position — "the sum across instances is the number that
 * matters and that is the collector's job, not this file's" — carried one step
 * further, because the *counting* is the collector's job too.
 *
 * Three alternatives were considered and are worth recording:
 *
 * - **A periodic flush of the totals.** Cheaper in log volume and wrong on
 *   this host: Cloud Run throttles CPU to near zero between requests, so a
 *   timer is not guaranteed to fire and the last interval before an instance
 *   dies is lost. Inside a request is the only moment CPU is certain.
 * - **A per-query summary line.** Eight times less volume, and it needs a
 *   request-scoped counter threaded through both the fetch stage and the
 *   upstream rotation, or an AsyncLocalStorage. Both are real changes to code
 *   that is correct now, to buy a ratio that comes out identical either way.
 * - **Writing counters to Postgres.** Buys durability by adding a write to the
 *   exact path the cache exists to make cheaper.
 *
 * What this does cost is a line per cache lookup — call it ten per query, a
 * couple of hundred bytes each. At PLAN.md's own 100k queries/month break-even
 * that is comfortably inside Cloud Logging's free allowance, and if it ever
 * stops being, the per-query summary above is the upgrade.
 *
 * ## What is deliberately not in the line
 *
 * No URL, no query, no caller. `/health` already reports these counts outside
 * the token gate on the grounds that they "name no query, no URL and no
 * caller, so there is nothing here to protect" — and that stays true only if
 * it stays true here. This function is the right home for the emission partly
 * *because* it has none of those things in scope to leak: PLAN.md keeps the
 * query log unlinked from any identity, and a cache metric is not the place to
 * quietly reintroduce one.
 *
 * Deliberately not a histogram or a timer. The question at this stage is "what
 * fraction of pages did we avoid fetching", which is two integers.
 */

export type CacheName = "content" | "query";

export type CacheOutcome = "hit" | "miss" | "revalidated";

/**
 * The line the log-based metric extracts its labels from.
 *
 * `metric` is a constant discriminator rather than a match on the message
 * text, so the filter does not break the day somebody rewords the log. These
 * two field names are the metric's only dimensions and
 * `monitoring/cache-lookup-metric.yaml` must agree with them — a rename here
 * silently empties the dashboard, which is why the filter is asserted in
 * `test/cache.test.ts` rather than left to a comment.
 */
function report(cache: CacheName, outcome: CacheOutcome): void {
	logger.info({ metric: "cache_lookup", cache, outcome }, "cache lookup");
}

type Counter = { hits: number; misses: number; revalidated: number };

const counters: Record<CacheName, Counter> = {
	content: { hits: 0, misses: 0, revalidated: 0 },
	query: { hits: 0, misses: 0, revalidated: 0 },
};

export function recordHit(cache: CacheName): void {
	counters[cache].hits += 1;
	report(cache, "hit");
}

export function recordMiss(cache: CacheName): void {
	counters[cache].misses += 1;
	report(cache, "miss");
}

/**
 * A conditional request that came back 304.
 *
 * Counted apart from a plain hit because the two have different costs and the
 * distinction is the whole argument for revalidation: a revalidated document
 * still costs a round trip, but it costs no bandwidth, no extraction and no
 * re-chunking. Folding it into `hits` would overstate what was saved; folding
 * it into `misses` would understate it.
 */
export function recordRevalidated(cache: CacheName): void {
	counters[cache].revalidated += 1;
	report(cache, "revalidated");
}

export type CacheStats = {
	hits: number;
	misses: number;
	revalidated: number;
	/**
	 * `(hits + revalidated) / total`, or null when nothing has been looked up.
	 *
	 * Null rather than 0: a fresh instance that has served no queries has no hit
	 * rate, and reporting `0` for it would drag a dashboard average down with
	 * data that does not exist. The Phase 0 gate is >0.55 on content, and a
	 * scale-to-zero service would never clear it if every cold start voted zero.
	 */
	hitRate: number | null;
};

function summarize(counter: Counter): CacheStats {
	const total = counter.hits + counter.misses + counter.revalidated;
	return {
		hits: counter.hits,
		misses: counter.misses,
		revalidated: counter.revalidated,
		hitRate: total === 0 ? null : (counter.hits + counter.revalidated) / total,
	};
}

export function cacheStats(): Record<CacheName, CacheStats> {
	return {
		content: summarize(counters.content),
		query: summarize(counters.query),
	};
}

/** Test-only. Nothing in the request path resets these. */
export function resetCacheStats(): void {
	for (const key of Object.keys(counters) as CacheName[]) {
		counters[key] = { hits: 0, misses: 0, revalidated: 0 };
	}
}
