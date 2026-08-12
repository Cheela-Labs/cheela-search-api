import { type Chunk, chunkText } from "./chunk";
import type { RetrievedPage } from "./fetch";

/**
 * Ranks passages against the query and keeps the best dozen.
 *
 * ## Lexical, for now, and that is a decision rather than a placeholder
 *
 * PLAN.md's step 5 says "chunk, embed, rerank". This ships the chunking and the
 * ranking; the embedding stage is deliberately not here yet, for a reason the
 * plan itself argues: *every stage has a plausible-sounding improvement that
 * makes end-to-end quality worse, and without per-stage measurement you ship all
 * of them and cannot tell which one did the damage.*
 *
 * BM25 over freshly fetched passages is a strong baseline — this is not a
 * global index where lexical retrieval misses everything phrased differently,
 * it is a hundred-odd passages from pages an upstream engine already decided
 * were about this query. Semantic ranking earns its cost on top of that or it
 * does not, and the eval harness is what says which. Adding it first would mean
 * paying a model call per query on the request path with no measurement saying
 * it helped.
 *
 * `Ranker` is the seam. When embeddings arrive they are a second implementation
 * and the harness compares them, rather than a rewrite of this file.
 *
 * ## The per-document cap is a citation decision, not a ranking one
 *
 * Twelve passages from one page is a well-ranked answer with one source, and
 * the surface renders it as a single citation repeated twelve times. Capping
 * per document costs some precision on the head and buys an answer that can be
 * corroborated, which is the product.
 */

export type Passage = Chunk & {
	/** Index into the pages array this was ranked from. */
	documentIndex: number;
	url: string;
	domain: string;
	title: string | null;
	score: number;
};

export type RankOptions = {
	/** How many passages survive. The composer's context is built from these. */
	limit?: number;
	/** Most passages any single document may contribute. */
	perDocumentLimit?: number;
};

const DEFAULT_LIMIT = 12;
const DEFAULT_PER_DOCUMENT = 3;

/** BM25's usual constants. Tuned by the literature, not by us, and not yet worth it. */
const K1 = 1.2;
const B = 0.75;

/**
 * Lowercased alphanumeric runs.
 *
 * No stemming and no stopword list. Stemming needs a language and gets English
 * possessives wrong in ways that matter for proper nouns — and proper nouns are
 * most of what distinguishes one technical passage from another. Stopwords are
 * handled by BM25 itself: a term in every passage gets an IDF near zero, which
 * is the same outcome without a list to maintain.
 */
function tokenise(text: string): string[] {
	return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export type Ranker = {
	readonly name: string;
	rank(query: string, passages: Passage[], limit: number): Promise<Passage[]>;
};

/**
 * BM25 over the passages retrieved for this one query.
 *
 * The corpus is small — a hundred passages, not a hundred million — so IDF here
 * is noisier than it would be over a real index. It still does the job it is
 * needed for: separating a passage that mentions the query's distinctive terms
 * from one that mentions only its common ones.
 */
export const lexicalRanker: Ranker = {
	name: "bm25",

	async rank(query, passages, limit) {
		const queryTerms = [...new Set(tokenise(query))];
		if (queryTerms.length === 0 || passages.length === 0) {
			return passages.slice(0, limit);
		}

		const tokenised = passages.map((passage) => tokenise(passage.text));
		const lengths = tokenised.map((terms) => terms.length);
		const averageLength =
			lengths.reduce((total, length) => total + length, 0) / lengths.length ||
			1;

		// Document frequency per query term, over this passage set.
		const documentFrequency = new Map<string, number>();
		for (const term of queryTerms) {
			let count = 0;
			for (const terms of tokenised) if (terms.includes(term)) count += 1;
			documentFrequency.set(term, count);
		}

		const total = passages.length;
		const scored = passages.map((passage, index) => {
			const terms = tokenised[index] as string[];
			const length = lengths[index] as number;

			const frequency = new Map<string, number>();
			for (const term of terms) {
				frequency.set(term, (frequency.get(term) ?? 0) + 1);
			}

			let score = 0;
			for (const term of queryTerms) {
				const termFrequency = frequency.get(term) ?? 0;
				if (termFrequency === 0) continue;

				const df = documentFrequency.get(term) ?? 0;
				// The `+ 1` keeps IDF positive: without it a term appearing in more
				// than half the passages scores negative and actively demotes the
				// passages that contain it.
				const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
				const denominator =
					termFrequency + K1 * (1 - B + (B * length) / averageLength);
				score += idf * ((termFrequency * (K1 + 1)) / denominator);
			}

			return { ...passage, score };
		});

		return scored.sort((a, b) => b.score - a.score).slice(0, limit);
	},
};

/**
 * Chunks every retrieved page and returns the best passages across all of them.
 *
 * Ranking happens over the whole pool rather than per page, then the
 * per-document cap is applied to the ranked order — so a document contributes
 * its *best* passages, not its first ones.
 */
export async function selectPassages(
	query: string,
	pages: readonly RetrievedPage[],
	options: RankOptions = {},
	ranker: Ranker = lexicalRanker,
): Promise<Passage[]> {
	const limit = options.limit ?? DEFAULT_LIMIT;
	const perDocument = options.perDocumentLimit ?? DEFAULT_PER_DOCUMENT;

	const pool: Passage[] = [];
	pages.forEach((page, documentIndex) => {
		for (const chunk of chunkText(page.extraction.text)) {
			pool.push({
				...chunk,
				documentIndex,
				url: page.extraction.canonicalUrl,
				domain: page.domain,
				title: page.extraction.title,
				score: 0,
			});
		}
	});

	if (pool.length === 0) return [];

	// Ranked deeper than the limit, because the cap below removes passages and
	// the shortfall has to be filled from somewhere. Without the headroom, a
	// single dominant document leaves the answer short of sources.
	const ranked = await ranker.rank(query, pool, limit * 4);

	const kept: Passage[] = [];
	const perDocumentCount = new Map<number, number>();

	for (const passage of ranked) {
		if (kept.length >= limit) break;
		const seen = perDocumentCount.get(passage.documentIndex) ?? 0;
		if (seen >= perDocument) continue;
		perDocumentCount.set(passage.documentIndex, seen + 1);
		kept.push(passage);
	}

	// If the cap left us short — few documents, many passages each — fill from
	// what is left rather than returning a thin context. A single-source answer
	// is worse than an uncorroborated one, but an empty one is worse than both.
	if (kept.length < limit) {
		const used = new Set(
			kept.map((passage) => `${passage.documentIndex}:${passage.ordinal}`),
		);
		for (const passage of ranked) {
			if (kept.length >= limit) break;
			if (used.has(`${passage.documentIndex}:${passage.ordinal}`)) continue;
			kept.push(passage);
		}
	}

	return kept;
}
