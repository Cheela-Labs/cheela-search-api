import type { Rotation } from "./cached-rotation";
import type { RotationResult } from "./rotation";
import {
	type Candidate,
	DEFAULT_LIMIT,
	interleaveAll,
	type SearchOptions,
	type SearchProvider,
	UpstreamError,
} from "./types";

/**
 * Asking several providers at once and merging what comes back.
 *
 * This is the alternative to `createRotation`'s failover, and the two answer
 * different questions. Failover asks "who can answer"; fan-out asks "what does
 * everyone think". Fan-out costs one call per provider on **every** query,
 * including the ones the first provider would have answered perfectly — and
 * PLAN.md's cost model is explicit that upstream API calls are the dominant
 * cost per query, so this multiplies the largest line item by the number of
 * paid vendors. It is a money decision and it is configured, not defaulted.
 *
 * ## Why round-robin is the only merge policy here
 *
 * There is no principled way to merge two vendors' *scores* — one provider's
 * 0.9 and another's 0.9 answer different questions, and normalising them
 * invents an agreement that does not exist. Position is comparable: each
 * provider's first result is its own best guess. So `interleaveAll` takes one
 * from each in turn and the reranker settles quality later, over text we
 * fetched and read ourselves, which is the only comparison in this pipeline
 * grounded in something we verified.
 *
 * That reasoning is also why `createRotation`'s doc comment argued against
 * fan-out: the reranker already re-orders everything, so a second opinion about
 * *ordering* buys little. What it does buy — and what that argument missed — is
 * a different **candidate set**. Two vendors disagree about which ten pages
 * exist far more than they disagree about their order, and a page that is never
 * fetched cannot be reranked into the answer.
 */

/** How many results a free specialist is asked for. See `withSupplements`. */
const SUPPLEMENT_LIMIT = 3;

/**
 * How many extra candidates a supplemented search may return.
 *
 * Not zero, and the reason is the failure this would otherwise cause: merging
 * specialists into a fixed budget means every Wikipedia result displaces a
 * general web result. On `nike jordans` that is strictly worse — an
 * encyclopedia article about the shoe crowding out the shops that sell it — and
 * the specialists have no way to know the query was not for them.
 *
 * So they are additive within a small ceiling. Three extra pages on a stage
 * that already runs six concurrent fetches is at most one more wave, and the
 * deadline is per page regardless.
 */
const SUPPLEMENT_EXTRA = 3;

function detailOf(error: unknown): string {
	return error instanceof UpstreamError
		? error.message
		: error instanceof Error
			? error.message
			: String(error);
}

type Settled = {
	lists: Candidate[][];
	/** Names of providers that answered, in the order they were asked. */
	answered: string[];
	failures: RotationResult["failures"];
};

/**
 * Runs every provider concurrently and sorts the outcomes.
 *
 * `allSettled` rather than `all`: one vendor being down must not discard the
 * answers of the ones that worked, which is the entire point of asking several.
 */
async function settle(
	providers: readonly SearchProvider[],
	query: string,
	options: SearchOptions | undefined,
	limit: number,
): Promise<Settled> {
	const results = await Promise.allSettled(
		providers.map((provider) =>
			provider.search(query, { ...options, limit } as SearchOptions),
		),
	);

	const lists: Candidate[][] = [];
	const answered: string[] = [];
	const failures: RotationResult["failures"] = [];

	results.forEach((result, index) => {
		const provider = providers[index] as SearchProvider;
		if (result.status === "fulfilled") {
			answered.push(provider.name);
			if (result.value.length > 0) lists.push(result.value);
		} else {
			failures.push({
				provider: provider.name,
				detail: detailOf(result.reason),
			});
		}
	});

	return { lists, answered, failures };
}

/**
 * Every provider, in parallel, merged.
 *
 * `provider` names the first one that *answered*, which includes answering with
 * nothing. Null still means what it means in `createRotation` — every provider
 * failed — because the pipeline turns that into an error frame, and a query
 * where one vendor was merely empty is not an outage.
 */
export function createFanout(providers: readonly SearchProvider[]): Rotation {
	if (providers.length === 0) {
		throw new Error("a search fan-out needs at least one provider");
	}

	return {
		get names(): string[] {
			return providers.map((provider) => provider.name);
		},

		async search(
			query: string,
			options?: SearchOptions,
		): Promise<RotationResult> {
			const limit = options?.limit ?? DEFAULT_LIMIT;
			const { lists, answered, failures } = await settle(
				providers,
				query,
				options,
				limit,
			);

			// A caller that gave up gets the same treatment as in the rotation: the
			// abort surfaces rather than being reported as a vendor failure.
			if (options?.signal?.aborted) {
				throw new Error("aborted");
			}

			return {
				candidates: interleaveAll(lists, limit),
				provider: answered[0] ?? null,
				failures,
			};
		},
	};
}

/**
 * A primary search, plus free specialists asked at the same time.
 *
 * The composition that actually ships: the paid general vendors keep whatever
 * policy they were given — failover or fan-out — and Wikipedia and GitHub ride
 * alongside, because they cost nothing and therefore do not have to justify
 * themselves against the query. A specialist that returns something useless is
 * out-ranked by BM25 over passages; a specialist that is absent cannot be.
 *
 * **A specialist failing is never a query failure.** Their failures are
 * reported for the trace and nothing branches on them. GitHub in particular
 * will rate-limit, by design, and a query must not get worse because the free
 * retriever ran out of quota.
 *
 * The one case where they change the verdict: if the primary failed *entirely*
 * and a specialist answered, the result is theirs rather than an error. A
 * degraded answer from Wikipedia beats "no search provider answered" on a query
 * we can, in fact, still answer.
 */
export function withSupplements(
	primary: Rotation,
	supplements: readonly SearchProvider[],
): Rotation {
	if (supplements.length === 0) return primary;

	return {
		get names(): string[] {
			// Deliberately the primary's names only. `withQueryCache` walks this
			// list to look for a cached entry, and the cache is keyed by the
			// provider that answered — which is always a primary name when there
			// was one. Adding the specialists here would make it probe for keys
			// that are never written.
			return primary.names;
		},

		async search(
			query: string,
			options?: SearchOptions,
		): Promise<RotationResult> {
			const limit = options?.limit ?? DEFAULT_LIMIT;

			// Started before it is awaited, so the specialists overlap the primary
			// instead of following it. Their latency is then hidden inside the
			// general vendor's own 500–1700 ms rather than added to it — the same
			// trick the classifier uses to be free.
			const supplementing = settle(
				supplements,
				query,
				options,
				SUPPLEMENT_LIMIT,
			);

			const [main, extra] = await Promise.all([
				primary.search(query, options),
				supplementing,
			]);

			const failures = [...main.failures, ...extra.failures];

			// Primary list first, so its results win every tie in the round-robin.
			const candidates = interleaveAll(
				[main.candidates, ...extra.lists],
				main.candidates.length > 0 ? limit + SUPPLEMENT_EXTRA : limit,
			);

			return {
				candidates,
				provider: main.provider ?? extra.answered[0] ?? null,
				failures,
			};
		},
	};
}
