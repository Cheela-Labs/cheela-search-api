import { matchesOfficial } from "@cheela/search-core";
import type { Intent } from "../../contracts/intent.js";
import { CONFIDENT } from "../../contracts/intent.js";
import type { RetrievedDocument } from "../retriever/index.js";

/**
 * The Entity-Aware Ranking Layer.
 *
 * Retrieval and reranking answer "which of these pages is most about the
 * query". For a navigational query that is the wrong question. "redis" is not a
 * request for the best page about Redis — it is a request for Redis, and the
 * only correct first result is redis.io. No amount of BM25 or cosine similarity
 * discovers that, because it is not a claim about text; it is a claim about
 * identity, and identity has to be looked up.
 *
 * So this runs after retrieval and after reranking, changes neither, and only
 * reorders.
 *
 * ## Why it reorders rather than rescoring
 *
 * The scores arriving here are not on one scale, and there is no honest
 * constant to add to them:
 *
 *   - `fusedScore` is RRF, roughly 0.01-0.07
 *   - a Vespa first-phase relevance is roughly 0-3
 *   - index and external results come from *two independent* RRF runs, so
 *     their scores are ordinally meaningful within each group and meaningless
 *     across it
 *   - external documents carry `features: {}` and a hard-coded `authority` of
 *     0.5, so anything reading features systematically demotes them
 *
 * Adding +2.0 to a number that might be 0.02 or might be 2.9 is not a boost,
 * it is a coin toss. So each origin group is converted to a rank-derived score
 * on a known 0..1 scale first, the adjustments are expressed in those units,
 * and the result is an ordering. Nothing is written to the wire — `Result` has
 * no score field, on purpose.
 */

/**
 * The adjustments, as data.
 *
 * A table rather than conditionals threaded through the scorer, so that the
 * policy is legible in one place and so the click-feedback rollup can one day
 * supply these numbers instead of a person editing them. That is the whole
 * point of expressing this as ranking features rather than as rules.
 */
/**
 * One rank position, in score units.
 *
 * Every adjustment below is expressed as a multiple of this, which is the only
 * way the word "soft" in "soft penalty" means anything. The first attempt used
 * `1/(1+rank)` for the base score — a 0.5 gap between first and second place —
 * against penalties of 0.15, so a "moderate" penalty moved nothing at all and a
 * homepage boost lost to whatever retrieval happened to rank first. The tests
 * caught both. Position units make each number a statement anyone can check:
 * Wikipedia drops three places, not "0.15 of something".
 */
const POSITION = 0.05;

/**
 * The adjustments, as data.
 *
 * A table rather than conditionals threaded through the scorer, so the policy
 * is legible in one place and so the click-feedback rollup can one day supply
 * these numbers instead of a person editing them. That is what expressing this
 * as ranking features rather than as rules is for.
 */
export const SIGNALS = {
	/**
	 * Large enough to win outright, and deliberately not a competitive boost.
	 *
	 * The base scale tops out at 1.0, so 2.0 puts any official-domain result
	 * above every non-official one regardless of how well they matched. That is
	 * intended: on a confident navigational query the official site is not a
	 * *better* answer, it is *the* answer, and a boost that merely competed
	 * would leave the outcome to how many GitHub pages happened to be retrieved.
	 */
	official: 2,
	/**
	 * Depth, from the homepage down, applied only to official results.
	 *
	 * The spread here is far wider than one position because within the official
	 * domain depth should decide the order, not retrieval rank — `redis` wants
	 * redis.io/, and which of its pages the index happened to like best is not
	 * the question being asked.
	 */
	homepage: [1, 0.6, 0.3, 0.1],
	/**
	 * Soft, navigational-only, and stated in positions.
	 *
	 * These domains win navigational queries by being encyclopaedic about
	 * everything. They are not being punished for being bad — Wikipedia is the
	 * right answer for `redis wiki` and must still win it — so each drops a
	 * result by a few places and nothing is removed.
	 */
	penalties: {
		"wikipedia.org": 3 * POSITION,
		"github.com": 2 * POSITION,
		"reddit.com": 2 * POSITION,
		"stackoverflow.com": POSITION,
		"medium.com": POSITION,
		"quora.com": POSITION,
	} as Record<string, number>,
	/**
	 * How much retrieval rank still counts once a result is official.
	 *
	 * Small: enough to break ties between two pages at the same depth, not
	 * enough to reorder depths. `0.05 × 1.0` is below the smallest gap in the
	 * depth table (0.2), which is the property that keeps depth primary.
	 */
	officialRankWeight: 0.05,
} as const;

export type EntitySignals = {
	intent: Intent;
	entity?: string;
	officialDomain?: string;
	confidence: number;
};

/**
 * How far from the homepage, capped at the table's length.
 *
 * `/` is 0, `/docs` is 1, `/docs/latest` is 2. A trailing slash is not a level.
 */
export function depthOf(path: string): number {
	return path.split("/").filter(Boolean).length;
}

function homepageBoost(path: string): number {
	const depth = depthOf(path);
	const table = SIGNALS.homepage;
	return table[Math.min(depth, table.length - 1)];
}

function penaltyFor(domain: string): number {
	for (const [suffix, penalty] of Object.entries(SIGNALS.penalties)) {
		if (matchesOfficial(domain, suffix)) return penalty;
	}
	return 0;
}

/**
 * A rank-derived base score, computed per origin group, one position apart.
 *
 * Rank rather than the score itself, because the scores are not comparable
 * across groups and barely interpretable within one. Rank is what RRF already
 * decided and is the same shape in both groups, which is exactly the property
 * needed to put an index result and an external one on one axis for the first
 * time.
 *
 * Uniform steps rather than a curve, so an adjustment means the same thing
 * everywhere in the list: a three-position penalty moves a result three places
 * whether it was ranked second or twelfth. A curve would make the same number
 * decisive at the top and inert in the tail.
 */
function baseScores(documents: RetrievedDocument[]): Map<string, number> {
	const scores = new Map<string, number>();
	for (const origin of ["index", "external"] as const) {
		const group = documents.filter((document) => document.origin === origin);
		group.forEach((document, index) => {
			scores.set(document.url, Math.max(0, 1 - index * POSITION));
		});
	}
	return scores;
}

export type Scored = {
	document: RetrievedDocument;
	score: number;
	official: boolean;
};

/**
 * Scores every document, for the ordering and for anything that wants to know
 * why. Exported so the policy can be tested without a running pipeline.
 */
export function scoreWithEntitySignals(
	documents: RetrievedDocument[],
	signals: EntitySignals,
): Scored[] {
	const base = baseScores(documents);

	// The gate. Below `CONFIDENT` the intent is a guess, and this layer's
	// adjustments are large enough that acting on a guess actively reorders
	// results away from what was asked.
	const navigational =
		signals.intent === "navigation" && signals.confidence >= CONFIDENT;

	return documents.map((document) => {
		const score = base.get(document.url) ?? 0;
		if (!navigational) return { document, score, official: false };

		const official = Boolean(
			signals.officialDomain &&
				matchesOfficial(document.domain, signals.officialDomain),
		);

		if (official) {
			return {
				document,
				score:
					SIGNALS.official +
					homepageBoost(document.path) +
					score * SIGNALS.officialRankWeight,
				official: true,
			};
		}

		// Never both: a penalty domain that *is* the official domain — github.com
		// for the query "github" — must not be demoted for being itself.
		return {
			document,
			score: score - penaltyFor(document.domain),
			official: false,
		};
	});
}

/**
 * The layer.
 *
 * Stable within equal scores: `sort` is stable in every engine this runs on, so
 * documents the signals do not distinguish keep the order retrieval gave them.
 * That matters more than it sounds — it means a query with no registry hit and
 * a non-navigational intent comes out byte-identical to its input, which is the
 * property that makes this safe to run on every request.
 */
export function applyEntitySignals(
	documents: RetrievedDocument[],
	signals: EntitySignals,
): RetrievedDocument[] {
	if (documents.length === 0) return documents;

	return scoreWithEntitySignals(documents, signals)
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) =>
			b.entry.score === a.entry.score
				? a.index - b.index
				: b.entry.score - a.entry.score,
		)
		.map(({ entry }) => entry.document);
}
