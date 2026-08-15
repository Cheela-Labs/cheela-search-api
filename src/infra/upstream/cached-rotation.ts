import { recordHit, recordMiss } from "../../shared/metrics";
import type { QueryCache } from "../db/query-cache";
import type { RotationResult } from "./rotation";
import type { SearchOptions } from "./types";

/** The shape `createRotation` returns, and all this wrapper needs of it. */
export type Rotation = {
	readonly names: string[];
	search(query: string, options?: SearchOptions): Promise<RotationResult>;
};

/**
 * A rotation that answers from `web.query_cache` when it can.
 *
 * Wrapped rather than built into `createRotation` because the rotation's job is
 * failover between vendors and this one's is not spending money twice. Kept
 * apart, the failover logic stays testable without a database and the cache
 * stays testable without vendors.
 *
 * **Lookup follows rotation order, and that is the point.** The cache is keyed
 * `(query, provider)` because two vendors answering one query are two different
 * answers. On the way in we do not yet know who will answer, so we ask the
 * cache in the same order the rotation would try them: the first provider with
 * a fresh entry wins, which is exactly who would have answered had every
 * provider been healthy.
 *
 * A cached result reports `failures: []`. Nothing failed *this time* — the
 * failures list describes what happened during this call, and inventing a
 * history from a previous one would misattribute an outage to a request that
 * never made it.
 */
export function withQueryCache(
	rotation: Rotation,
	cache: QueryCache,
): Rotation {
	return {
		get names(): string[] {
			return rotation.names;
		},

		async search(
			query: string,
			options?: SearchOptions,
		): Promise<RotationResult> {
			for (const provider of rotation.names) {
				const cached = await cache.get(query, provider);
				if (!cached || cached.length === 0) continue;

				recordHit("query");
				return {
					candidates: cached.map((candidate, index) => ({
						url: candidate.url,
						title: candidate.title,
						// Rank is regenerated from stored order rather than persisted.
						// The order *is* the ranking, so a separate column could only
						// ever disagree with it.
						rank: index + 1,
						provider,
					})),
					provider,
					failures: [],
				};
			}

			recordMiss("query");
			const result = await rotation.search(query, options);

			// Only a real answer is cached. `provider === null` means every vendor
			// failed, and storing that would turn one bad minute into a TTL-long
			// outage that no healthy vendor could rescue.
			if (result.provider && result.candidates.length > 0) {
				await cache.put(
					query,
					result.provider,
					result.candidates.map((candidate) => ({
						url: candidate.url,
						title: candidate.title,
					})),
				);
			}

			return result;
		},
	};
}
