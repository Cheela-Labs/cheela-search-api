/**
 * Cache counters, in process.
 *
 * PLAN.md gates step 7 on "hit rate is on a dashboard, from the first day it
 * can be", and argues why: **cache hit rate decides unit economics outright at
 * MVP**, because the dominant cost per query is upstream calls and page
 * fetches. A cache with no hit rate is a cache nobody can defend.
 *
 * In process, and reset when the instance is replaced. That is a real
 * limitation and it is the right first step anyway: the alternative is a
 * counters table written on the request path, which buys durability by adding
 * a write to the very path the cache exists to make cheaper. Cloud Run scrapes
 * this per instance; the sum across instances is the number that matters and
 * that is the collector's job, not this file's.
 *
 * Deliberately not a histogram or a timer. The question at this stage is "what
 * fraction of pages did we avoid fetching", which is two integers.
 */

export type CacheName = "content" | "query";

type Counter = { hits: number; misses: number; revalidated: number };

const counters: Record<CacheName, Counter> = {
	content: { hits: 0, misses: 0, revalidated: 0 },
	query: { hits: 0, misses: 0, revalidated: 0 },
};

export function recordHit(cache: CacheName): void {
	counters[cache].hits += 1;
}

export function recordMiss(cache: CacheName): void {
	counters[cache].misses += 1;
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
