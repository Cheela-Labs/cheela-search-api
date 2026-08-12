import {
	type Candidate,
	type SearchOptions,
	type SearchProvider,
	UpstreamError,
} from "./types";

/**
 * Tries providers in order and returns the first set that arrives.
 *
 * Failover, not fan-out. Asking both vendors on every query would double the
 * bill to merge two rankings we have no principled way to merge — and the
 * pipeline re-ranks over fetched passages anyway, so a second opinion about
 * ordering buys nothing that the reranker does not already provide.
 *
 * ## An empty result set is not a failure
 *
 * A provider that answers "nothing matched" has done its job, and falling
 * through to the next one would turn every genuinely unanswerable query into a
 * full sweep of every vendor — at their cost, on every zero-result query, which
 * is exactly the traffic shape a scraper-detection system enjoys. Only a thrown
 * `UpstreamError` moves to the next provider.
 */

export type RotationResult = {
	candidates: Candidate[];
	/** Which provider answered. Null when every one of them failed. */
	provider: string | null;
	/** In order, what went wrong before that. Empty on a first-try success. */
	failures: { provider: string; detail: string }[];
};

export function createRotation(providers: readonly SearchProvider[]) {
	if (providers.length === 0) {
		// Constructing a rotation over nothing is a wiring mistake, and the only
		// honest time to say so is now — a search service whose search is
		// unconfigured should not reach the point of answering a query.
		throw new Error("a search rotation needs at least one provider");
	}

	return {
		get names(): string[] {
			return providers.map((provider) => provider.name);
		},

		async search(
			query: string,
			options?: SearchOptions,
		): Promise<RotationResult> {
			const failures: RotationResult["failures"] = [];

			for (const provider of providers) {
				try {
					const candidates = await provider.search(query, options);
					return { candidates, provider: provider.name, failures };
				} catch (error) {
					// A caller that gave up stops the rotation. Without this, an
					// aborted request walks every remaining vendor before noticing,
					// spending their quota on an answer nobody is waiting for.
					if (options?.signal?.aborted) throw error;

					failures.push({
						provider: provider.name,
						detail:
							error instanceof UpstreamError
								? error.message
								: error instanceof Error
									? error.message
									: String(error),
					});
				}
			}

			// Every provider failed. Reported rather than thrown: the surface
			// renders "search failed" from an error *frame*, and the caller has the
			// per-provider detail it needs to say which vendor to look at.
			return { candidates: [], provider: null, failures };
		},
	};
}

export type SearchRotation = ReturnType<typeof createRotation>;
