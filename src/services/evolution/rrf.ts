/**
 * Reciprocal Rank Fusion.
 *
 *     RRF(d) = Σ  1 / (k + r_i(d))
 *
 * over every ranked list `i` in which document `d` appears, with `r` the
 * document's 1-based rank in that list. Both specification documents pin
 * `k = 60`.
 *
 * ### Why this and not score fusion
 *
 * The lists being merged come from different engines: Vespa's hybrid score,
 * Tavily's relevance, AnySearch's, and one list per retrieval hypothesis.
 * Their scores are not comparable — not on the same scale, not even
 * necessarily monotonic in the same thing — so averaging them means inventing
 * an exchange rate nobody can justify. RRF throws the scores away and keeps
 * only the ordering, which is the part every engine agrees is meaningful.
 *
 * The `k` constant is what stops the top of one list from dominating: at
 * k = 60 the difference between rank 1 and rank 2 is small (1/61 vs 1/62), so
 * a document that several lists rank *somewhere* beats one that a single list
 * ranks first. That is the whole point of running multiple hypotheses — it is
 * agreement across interpretations that is evidence, not depth within one.
 */

export type FusionInput<T> = {
	/** One ranked list, best first. */
	items: T[];
	/**
	 * How much this list is trusted. Defaults to 1.
	 *
	 * Used to keep a supplementary hypothesis from outvoting the query the
	 * user actually typed: the original gets 1.0, its expansions less.
	 */
	weight?: number;
	/** For attribution: which hypothesis or provider this list came from. */
	label?: string;
};

export type Fused<T> = {
	item: T;
	score: number;
	/** How many lists contained it. The agreement signal, exposed for ranking. */
	agreement: number;
	labels: string[];
};

export function reciprocalRankFusion<T>(
	lists: FusionInput<T>[],
	key: (item: T) => string,
	k = 60,
): Fused<T>[] {
	const merged = new Map<
		string,
		{ item: T; score: number; agreement: number; labels: string[] }
	>();

	for (const list of lists) {
		const weight = list.weight ?? 1;
		list.items.forEach((item, index) => {
			const id = key(item);
			if (!id) return;
			const rank = index + 1;
			const contribution = weight / (k + rank);

			const existing = merged.get(id);
			if (existing) {
				existing.score += contribution;
				existing.agreement += 1;
				if (list.label) existing.labels.push(list.label);
			} else {
				merged.set(id, {
					// First sighting wins the payload. Later lists may carry a
					// different title or snippet for the same URL, and switching
					// to the last one seen makes the merge order visible in the
					// output for no benefit.
					item,
					score: contribution,
					agreement: 1,
					labels: list.label ? [list.label] : [],
				});
			}
		});
	}

	return [...merged.values()].sort((a, b) =>
		// Ties broken by agreement, then stably: two documents with identical
		// fused scores should not swap places between identical requests.
		b.score === a.score ? b.agreement - a.agreement : b.score - a.score,
	);
}
