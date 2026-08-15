import type { Freshness } from "../route/classifier";
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
	/** The document's `og:image`, carried so the source list can show it. */
	image: string | null;
	/** The document's declared publish or modify date, for the freshness signal. */
	publishedAt: string | null;
	score: number;
};

export type RankOptions = {
	/** How many passages survive. The composer's context is built from these. */
	limit?: number;
	/** Most passages any single document may contribute. */
	perDocumentLimit?: number;
	/**
	 * The router's verdict on whether this query's answer moves. Only `high`
	 * turns on the recency signal — see `applySignals`.
	 */
	freshness?: Freshness;
};

const DEFAULT_LIMIT = 12;
const DEFAULT_PER_DOCUMENT = 3;

/**
 * How much a perfect title match multiplies a passage's score.
 *
 * **These are tie-breakers, not a retrieval mechanism, and the size is the
 * statement.** At 0.5 a passage from a page whose title contains every query
 * term is worth 1.5 of an otherwise identical passage: enough to reorder
 * near-equals, not enough to lift a weakly relevant passage over a strongly
 * relevant one. A weight large enough to do the latter would be doing
 * retrieval, and the thing that should be doing retrieval is retrieval.
 */
const TITLE_WEIGHT = 0.5;

/** The same, for a page that proved it is recent, on a query that wants recent. */
const FRESHNESS_WEIGHT = 0.6;

/**
 * How fast the recency bonus decays, in days.
 *
 * Thirty, so a page from this week is clearly preferred, one from last quarter
 * is barely distinguished, and one from last year is not boosted at all. The
 * queries this fires on — a current version, a price, a standing — go wrong on
 * a timescale of weeks, so the curve is shaped to that rather than to a news
 * cycle.
 */
const FRESHNESS_HALF_LIFE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1_000;

export type SignalOptions = {
	freshness?: Freshness;
	/** Injectable so a test does not depend on the wall clock. */
	now?: number;
	titleWeight?: number;
	freshnessWeight?: number;
	halfLifeDays?: number;
};

/**
 * Re-scores ranked passages on signals that are about the *document*, not about
 * how well its text matches the query.
 *
 * Kept out of `Ranker` on purpose. A ranker answers one question — how well
 * does this passage match this query — and every future implementation of that
 * seam, semantic or otherwise, would have to reimplement title and recency
 * handling if they lived inside it. They are the same two multipliers whatever
 * decided the base score.
 *
 * ## Multiplicative, because BM25 scores have no fixed scale
 *
 * A BM25 score depends on the query's IDF profile, so the same additive bonus
 * is decisive on one query and invisible on the next. A multiplier means
 * "worth half again as much" regardless of the magnitudes involved, which is a
 * statement somebody can reason about.
 *
 * ## A zero score stays zero, deliberately
 *
 * A passage containing none of the query's terms scores 0, and 0 times any
 * multiplier is 0. So a recent date cannot float a passage that is not about
 * the query — which is exactly the failure people mean when they say freshness
 * ranking made results worse.
 *
 * ## Absence of a date is never a penalty
 *
 * Most of the web declares no date. Recency can only promote a page that proved
 * it is recent; a page that said nothing ranks exactly as it would have without
 * this stage. Otherwise the signal would mostly measure whether a CMS emits
 * Open Graph tags.
 */
export function applySignals(
	passages: readonly Passage[],
	query: string,
	options: SignalOptions = {},
): Passage[] {
	const titleWeight = options.titleWeight ?? TITLE_WEIGHT;
	const freshnessWeight = options.freshnessWeight ?? FRESHNESS_WEIGHT;
	const halfLife = options.halfLifeDays ?? FRESHNESS_HALF_LIFE_DAYS;
	const now = options.now ?? Date.now();
	const wantsFresh = options.freshness === "high";

	const queryTerms = [...new Set(tokenise(query))];
	if (queryTerms.length === 0) return [...passages];

	// One title match per document, not per passage — the title is a property of
	// the page, and recomputing it for each of its passages is the same answer
	// arrived at three times.
	const titleMatchByDocument = new Map<number, number>();

	const scored = passages.map((passage) => {
		let titleMatch = titleMatchByDocument.get(passage.documentIndex);
		if (titleMatch === undefined) {
			const titleTerms = new Set(tokenise(passage.title ?? ""));
			titleMatch =
				titleTerms.size === 0
					? 0
					: queryTerms.filter((term) => titleTerms.has(term)).length /
						queryTerms.length;
			titleMatchByDocument.set(passage.documentIndex, titleMatch);
		}

		let multiplier = 1 + titleWeight * titleMatch;

		if (wantsFresh && passage.publishedAt) {
			const published = Date.parse(passage.publishedAt);
			if (!Number.isNaN(published)) {
				// Clamped at zero so a page dated slightly in the future — clock skew,
				// a scheduled post — is treated as "now" rather than as extra fresh.
				const ageDays = Math.max(0, (now - published) / DAY_MS);
				const recency = Math.exp(-ageDays / halfLife);
				multiplier *= 1 + freshnessWeight * recency;
			}
		}

		return { ...passage, score: passage.score * multiplier };
	});

	return scored.sort((a, b) => b.score - a.score);
}

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
				image: page.extraction.image,
				publishedAt: page.extraction.publishedAt,
				score: 0,
			});
		}
	});

	if (pool.length === 0) return [];

	// Ranked deeper than the limit, because the cap below removes passages and
	// the shortfall has to be filled from somewhere. Without the headroom, a
	// single dominant document leaves the answer short of sources.
	const shortlist = await ranker.rank(query, pool, limit * 4);

	/*
	  Document signals apply *within* the lexical shortlist, never to the whole
	  pool, and that boundary is deliberate. A passage BM25 placed outside the
	  top forty-eight is not one a matching title should rescue — signals break
	  ties among passages already judged relevant, and letting them reach further
	  makes the title tag a retrieval mechanism. It also keeps the seam's cost
	  contract intact: a future semantic ranker is still asked for a shortlist,
	  not for a score on every passage.
	*/
	const ranked = applySignals(shortlist, query, {
		...(options.freshness ? { freshness: options.freshness } : {}),
	});

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
