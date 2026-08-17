import type { Redis } from "ioredis";
import { logger } from "../../shared/logger.js";
import { redis as shared } from "./client.js";

/**
 * The three caches the TDS's caching section names, with its TTLs:
 * query (10 minutes), document (24 hours), entity (1 hour).
 *
 * Every method here swallows its errors and reports a miss. That is the whole
 * design rule for this file: a cache that can fail a request is a cache that
 * has made the system less available than it was without one. A Redis outage
 * costs money — more upstream calls, more fetches — and must not cost
 * availability.
 */

export type Cache<T> = {
	get(key: string): Promise<T | null>;
	put(key: string, value: T): Promise<void>;
	drop(key: string): Promise<void>;
};

export type CacheStats = {
	hits: number;
	misses: number;
	hitRate: number | null;
};

const counters = new Map<string, { hits: number; misses: number }>();

function record(name: string, hit: boolean): void {
	const entry = counters.get(name) ?? { hits: 0, misses: 0 };
	if (hit) entry.hits += 1;
	else entry.misses += 1;
	counters.set(name, entry);
	// One structured line per lookup, so hit rate is derivable from logs alone
	// on the day the in-process counters are not enough. The TDS gates on cache
	// hit rate; a number nobody can see is not a gate.
	logger.debug({ metric: "cache_lookup", cache: name, hit }, "cache lookup");
}

export function cacheStats(): Record<string, CacheStats> {
	const out: Record<string, CacheStats> = {};
	for (const [name, { hits, misses }] of counters) {
		const total = hits + misses;
		out[name] = { hits, misses, hitRate: total === 0 ? null : hits / total };
	}
	return out;
}

export function resetCacheStats(): void {
	counters.clear();
}

export function createCache<T>(
	name: string,
	ttlMs: number,
	client: Redis = shared,
): Cache<T> {
	const prefix = `cheela:cache:${name}:`;

	return {
		async get(key: string): Promise<T | null> {
			try {
				const raw = await client.get(prefix + key);
				if (raw === null) {
					record(name, false);
					return null;
				}
				record(name, true);
				return JSON.parse(raw) as T;
			} catch {
				// Includes a JSON parse failure on a value written by an older
				// shape. A miss is always a safe answer; a throw never is.
				record(name, false);
				return null;
			}
		},

		async put(key: string, value: T): Promise<void> {
			try {
				await client.set(
					prefix + key,
					JSON.stringify(value),
					"PX",
					Math.max(1, ttlMs),
				);
			} catch {
				// Nothing to do and nothing to report: the next read is a miss.
			}
		},

		async drop(key: string): Promise<void> {
			try {
				await client.del(prefix + key);
			} catch {
				/* see above */
			}
		},
	};
}

/**
 * Fixed-window rate limit.
 *
 * A sliding window would be more accurate and needs a sorted set per caller;
 * this needs one counter and one expiry. At the scale where the difference
 * between the two matters, the limit is not what should be protecting this
 * service.
 */
export async function rateLimit(
	key: string,
	max: number,
	windowMs: number,
	client: Redis = shared,
): Promise<{ allowed: boolean; remaining: number }> {
	try {
		const redisKey = `cheela:rl:${key}`;
		const count = await client.incr(redisKey);
		if (count === 1) await client.pexpire(redisKey, windowMs);
		return { allowed: count <= max, remaining: Math.max(0, max - count) };
	} catch {
		// Fail open. This limit exists to stop a public URL being a free search
		// engine, not to stop an attack — and a Redis blip that returns 429 to
		// every real user is a worse outcome than a minute of unmetered traffic.
		return { allowed: true, remaining: max };
	}
}
