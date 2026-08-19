import { matchesOfficial } from "@cheela/search-core";
import type { Intent } from "../../contracts/intent.js";
import type { Cache } from "../../infra/redis/cache.js";
import { config } from "../../shared/config.js";
import { logger } from "../../shared/logger.js";
import { traced } from "../../shared/telemetry.js";
import type { Hypothesis } from "../evolution/index.js";
import { reciprocalRankFusion } from "../evolution/rrf.js";
import { type Candidate, fanout, type SearchProvider } from "./providers.js";
import type {
	IndexedCapability,
	IndexedDocument,
	IndexStage,
} from "./vespa-stage.js";

export * from "./providers.js";
export * from "./vespa-stage.js";

/**
 * The Retriever: stage A, then stage B when stage A was not enough.
 *
 * Both stages run every hypothesis the evolution engine produced and fuse the
 * results with RRF. The fusion is what makes multiple hypotheses worth their
 * latency — a document that several interpretations of the query agree on is
 * better evidence than one that the literal query ranked first.
 */

export type RetrievedDocument = {
	docId: string;
	url: string;
	domain: string;
	path: string;
	title: string;
	snippet: string;
	body: string;
	chunks: string[];
	image?: string;
	authority: number;
	publishedAt: number;
	origin: "index" | "external";
	fusedScore: number;
	agreement: number;
	features: Record<string, number>;
};

export type Retrieval = {
	documents: RetrievedDocument[];
	capabilities: IndexedCapability[];
	servedFrom: "index" | "external" | "mixed";
	confidence: number;
	degraded: string[];
};

/**
 * How much to trust what the index returned.
 *
 * With the cross-encoder this is close to a calibrated number — the global
 * phase is mostly `sigmoid(logit)`, which is a relevance probability.
 *
 * ## Without it, the total relevance is the wrong number to read
 *
 * The first-phase score is
 *
 *     intent_boost x (lexical + semantic + authority + freshness
 *                     + entity_boost + graph_boost)
 *
 * and only two of those terms are about the query. Measured on the live index
 * for "colombia earthquake", against a corpus that is 99% github.com:
 *
 *     relevance 3.095   "Build software better, together"
 *       lexical   0.518   semantic  0.593    <- the query-dependent half
 *       authority 0.550   freshness 0.500    <- identical on every document
 *       graph     0.935                      <- the document's own importance
 *
 * Roughly two points of that three arrive before the document has matched
 * anything. Dividing the total by three therefore reported ~1.0 for a page
 * whose title is GitHub's tagline, the threshold was cleared, stage B never
 * ran, and a news query returned twenty github.com URLs while the providers
 * that had the actual news were never called. The same query and `redis`
 * produced near-identical lexical and semantic values — the signature of a
 * corpus in which everything is equally irrelevant to everything.
 *
 * So this reads the match, not the sum. `lexical` is a saturating BM25 and
 * `semantic` is closeness, both already 0..1 and both already about this
 * query; the rest is what makes a document good in general, which is a
 * different question from whether it answers what was asked.
 *
 * The larger of the two rather than their mean, because hybrid retrieval means
 * either signal can carry a match on its own — `semantic` is 0 for a document
 * found only lexically, and averaging would halve a perfect keyword hit.
 */
export function indexConfidence(
	documents: { fusedScore: number; features: Record<string, number> }[],
	reranked: boolean,
	topScore: number,
	features: Record<string, number> = {},
): number {
	if (documents.length === 0) return 0;

	const depth = Math.min(1, documents.length / 6);
	if (reranked) {
		// The reranked score is already 0..1 and already about this query.
		return Math.min(1, topScore) * (0.6 + 0.4 * depth);
	}

	const match = Math.max(features.lexical ?? 0, features.semantic ?? 0);
	return Math.min(1, match) * (0.5 + 0.5 * depth);
}

/**
 * Which hypothesis speaks for the index, and on which scale.
 *
 * Only one hypothesis reranks — the query as typed — so its top score is the
 * calibrated one and is what confidence should be read from. The bug this
 * exists to prevent is what happens when that one query fails.
 *
 * It used to be `stageA[0]?.result.documents[0]?.score ?? 0`, passed to
 * `indexConfidence` with `reranked` hard-coded to `true`. When the cross-encoder
 * blew its budget — which, on a two-vCPU node scoring 30 documents through a
 * cross-encoder, was *every single request* — that hypothesis returned no
 * documents, the score defaulted to 0, and `min(1, 0) × anything` is 0.
 * Confidence was therefore always exactly zero, always below the 0.62
 * threshold, and every search in production fell through to external providers.
 * The other three hypotheses had queried Vespa successfully the whole time and
 * their documents were sitting right there in the fusion; nothing ever looked
 * at them. An index of 29,179 documents answering in 24ms could not win a
 * single query, and the only outward symptom was `servedFrom: "external"`.
 *
 * So: prefer the reranked hypothesis, fall back to the best un-reranked one,
 * and — this is the half that matters — say which scale the number is on. The
 * two are an order of magnitude apart (0..1 against roughly 0..3), so returning
 * a first-phase score while claiming it is reranked would read 2.4 as a
 * saturated 1.0 and call every search confident. That is the same bug facing
 * the other way.
 *
 * Taking the maximum across the un-reranked hypotheses is deliberate. They are
 * rephrasings of one question, so the best evidence any of them found is the
 * best the index has for what was asked. It reads slightly higher than a single
 * query would, which is the right direction for a fallback: the alternative is
 * abandoning a working index because the optional refinement step is down.
 */
export function confidenceBasis(
	stage: {
		rerank: boolean;
		result: {
			documents: { score: number; features?: Record<string, number> }[];
		};
	}[],
): { topScore: number; reranked: boolean; features: Record<string, number> } {
	const reranked = stage.find(
		(entry) => entry.rerank && entry.result.documents.length > 0,
	);
	if (reranked) {
		const top = reranked.result.documents[0];
		return {
			topScore: top.score,
			reranked: true,
			features: top.features ?? {},
		};
	}

	// The features come from the same document the score does, so confidence is
	// read off one hit rather than assembled from two.
	let topScore = 0;
	let features: Record<string, number> = {};
	for (const entry of stage) {
		// Skipped rather than merged: a reranked score on the un-reranked scale
		// would be divided by three. It contributes nothing here anyway — we are
		// only in this branch because it returned no documents — but the skip is
		// what makes the scale invariant true by construction rather than by
		// coincidence.
		if (entry.rerank) continue;
		const top = entry.result.documents[0];
		if (top && top.score > topScore) {
			topScore = top.score;
			features = top.features ?? {};
		}
	}
	return { topScore, reranked: false, features };
}

export type RetrieverDeps = {
	index: IndexStage;
	providers: SearchProvider[];
	/** The TDS's 10-minute query cache, keyed by hypothesis. */
	queryCache?: Cache<Candidate[]>;
};

export type RetrieveOptions = {
	intent: Intent;
	entities: string[];
	limit?: number;
	/**
	 * The domain a navigational query is asking for, when one is known.
	 *
	 * Read for exactly one decision — whether stage B runs — and for nothing
	 * else. It does not enter a Vespa query, a rank profile, or a score.
	 */
	officialDomain?: string;
	signal?: AbortSignal;
};

const fromIndex = (
	document: IndexedDocument,
	fusedScore: number,
	agreement: number,
): RetrievedDocument => ({
	docId: document.docId,
	url: document.url,
	domain: document.domain,
	path: document.path,
	title: document.title,
	// The first chunk is the lead paragraph often enough to be a usable
	// snippet, and it is text we already hold rather than text to generate.
	snippet: document.chunks[0] ?? document.body.slice(0, 300),
	body: document.body,
	chunks: document.chunks,
	image: document.image,
	authority: document.authority,
	publishedAt: document.publishedAt,
	origin: "index",
	fusedScore,
	agreement,
	features: document.features,
});

const fromExternal = (
	candidate: Candidate,
	fusedScore: number,
	agreement: number,
): RetrievedDocument => ({
	docId: "",
	url: candidate.url,
	domain: (() => {
		try {
			return new URL(candidate.url).hostname.toLowerCase();
		} catch {
			return "";
		}
	})(),
	path: (() => {
		try {
			return new URL(candidate.url).pathname;
		} catch {
			return "/";
		}
	})(),
	title: candidate.title,
	snippet: candidate.snippet,
	// External results carry no body: this is a list of places to read, and
	// the reading happens in the indexer, off the request path.
	body: "",
	chunks: [],
	authority: 0.5,
	publishedAt: 0,
	origin: "external",
	fusedScore,
	agreement,
	features: {},
});

export function createRetriever(deps: RetrieverDeps) {
	return {
		async retrieve(
			hypotheses: Hypothesis[],
			options: RetrieveOptions,
		): Promise<Retrieval> {
			const limit = options.limit ?? 20;
			const degraded: string[] = [];

			// ---- Stage A -----------------------------------------------------

			const stageA = await traced("retriever.stageA", async () =>
				Promise.all(
					hypotheses.map(async (hypothesis) => {
						// Rerank only the query as typed. The cross-encoder is the
						// most expensive thing in the budget and running it on four
						// hypotheses would spend it four times to reorder lists that
						// RRF is about to merge anyway.
						//
						// Decided once and carried on the entry, so the thing that
						// asks for reranking and the thing that reads the reranked
						// score cannot drift apart. Re-deriving it from
						// `hypothesis.source` in both places is how they would.
						//
						// Gated, and currently off: the cross-encoder scores every
						// pair identically because `rerank_tokens` was never fed.
						// See VESPA_RERANK_ENABLED for the measurements.
						const rerank =
							config.VESPA_RERANK_ENABLED && hypothesis.source === "original";

						return {
							hypothesis,
							rerank,
							result: await deps.index.search(hypothesis.query, {
								intent: options.intent,
								entities: options.entities,
								limit,
								rerank,
								signal: options.signal,
							}),
						};
					}),
				),
			);

			// Two different degradations, reported as two different words.
			//
			// They were one, and the conflation cost real time: production
			// reported `degraded: ["vespa"]` on every search while Vespa was
			// answering in 24ms with full coverage, because the only thing
			// failing was the cross-encoder. "vespa" sent everyone looking at
			// the index; the index was fine. If only the reranking hypothesis
			// failed, say so — retrieval still happened, on the first-phase
			// ranking, and that is a materially better state than no index at
			// all.
			if (stageA.some((entry) => !entry.rerank && entry.result.failed)) {
				degraded.push("vespa");
			} else if (stageA.some((entry) => entry.rerank && entry.result.failed)) {
				degraded.push("rerank");
			}

			const indexed = reciprocalRankFusion(
				stageA.map((entry) => ({
					items: entry.result.documents,
					weight: entry.hypothesis.weight,
					label: entry.hypothesis.query,
				})),
				(document) => document.url,
			);

			const capabilities = dedupeCapabilities(
				stageA.flatMap((entry) => entry.result.capabilities),
			);

			const basis = confidenceBasis(stageA);
			const confidence = indexConfidence(
				indexed.map((entry) => ({
					fusedScore: entry.score,
					features: entry.item.features,
				})),
				basis.reranked,
				basis.topScore,
				basis.features,
			);

			const documents = indexed.map((entry) =>
				fromIndex(entry.item, entry.score, entry.agreement),
			);

			// A navigational query that did not find the site it named.
			//
			// The index can be *confident* and still not hold redis.io: `follow()`
			// in the crawler never leaves a domain, so a domain nobody seeded is
			// simply absent, and a confident answer made entirely of GitHub pages
			// is exactly what that looks like from here. Upstream providers do
			// hold it, so this is the one case where high index confidence is not
			// a reason to stop.
			//
			// Narrow on purpose: only a navigational query, only when an official
			// domain is known, and only when no retrieved document matches it. A
			// query whose official domain *was* found still short-circuits, so the
			// external budget is spent on the case this exists to fix and no other.
			const missingOfficial =
				options.officialDomain !== undefined &&
				!documents.some((document) =>
					matchesOfficial(document.domain, options.officialDomain as string),
				);

			if (confidence >= config.INDEX_CONFIDENCE_THRESHOLD && !missingOfficial) {
				// The architecture's "if confidence is high, return immediately".
				// This is the path that makes the engine cheap and fast, and it is
				// the one that gets more common as the index grows.
				return {
					documents: documents.slice(0, limit),
					capabilities,
					servedFrom: "index",
					confidence,
					degraded,
				};
			}

			// ---- Stage B -----------------------------------------------------

			const external = await traced("retriever.stageB", async () => {
				// Only the two best hypotheses go to the vendors. Every hypothesis
				// is a paid call, and past the second the marginal recall does not
				// pay for it.
				const asked = hypotheses.slice(0, 2);
				const results = await Promise.all(
					asked.map(async (hypothesis) => {
						const cached = await deps.queryCache?.get(hypothesis.query);
						if (cached) {
							return {
								hypothesis,
								lists: [{ provider: "cache", candidates: cached }],
								failed: [] as string[],
							};
						}

						const { lists, failed } = await fanout(
							deps.providers,
							hypothesis.query,
							{ limit, signal: options.signal },
						);

						const merged = lists.flatMap((list) => list.candidates);
						if (merged.length > 0) {
							void deps.queryCache?.put(hypothesis.query, merged);
						}
						return { hypothesis, lists, failed };
					}),
				);
				return results;
			});

			for (const entry of external) {
				for (const provider of entry.failed) {
					if (!degraded.includes(provider)) degraded.push(provider);
				}
			}

			const fusedExternal = reciprocalRankFusion(
				external.flatMap((entry) =>
					entry.lists.map((list) => ({
						items: list.candidates,
						weight: entry.hypothesis.weight,
						label: `${list.provider}:${entry.hypothesis.query}`,
					})),
				),
				(candidate) => candidate.url,
			);

			if (fusedExternal.length === 0 && documents.length === 0) {
				logger.warn({ degraded }, "no results from either stage");
			}

			// Index results keep their place ahead of external ones at equal
			// evidence: we have read those pages, so their titles and snippets
			// are ours rather than a vendor's summary of them.
			//
			// "At equal evidence" is doing real work in that sentence, and one
			// case is not equal: an external result *on the domain a
			// navigational query named*. Without this it was fetched and then
			// discarded before anything could rank it — the index returned a
			// full page of 20, `slice(0, limit)` cut the external list off
			// entirely, and `redis` came back as twenty github.com URLs with
			// redis.io nowhere in the response despite stage B having just gone
			// and got it.
			const seen = new Set(documents.map((document) => document.url));
			const externalDocuments = fusedExternal
				.filter((entry) => !seen.has(entry.item.url))
				.map((entry) => fromExternal(entry.item, entry.score, entry.agreement));

			const isOfficial = (document: RetrievedDocument): boolean =>
				options.officialDomain !== undefined &&
				matchesOfficial(document.domain, options.officialDomain);

			// And when the index did *not* earn its place, it goes second.
			//
			// "At equal evidence" is the whole justification for index-first, and
			// a confidence below the threshold is precisely the statement that
			// the evidence is not equal — it is why stage B was run at all. Left
			// unconditional, the index still filled all 20 slots and the external
			// results it had just paid for were truncated away: `colombia
			// earthquake` reached stage B, fetched the news, and returned twenty
			// github.com URLs anyway.
			//
			// The one case that keeps index-first is a confident index that was
			// sent to stage B only to find a missing official domain. There the
			// index is good and the vendor is filling one specific gap, which the
			// hoist above already handles.
			const trusted = confidence >= config.INDEX_CONFIDENCE_THRESHOLD;
			const others = externalDocuments.filter(
				(document) => !isOfficial(document),
			);

			const combined = [
				...externalDocuments.filter(isOfficial),
				...(trusted ? documents : others),
				...(trusted ? others : documents),
			];

			return {
				documents: combined.slice(0, limit),
				capabilities,
				servedFrom: documents.length > 0 ? "mixed" : "external",
				confidence,
				degraded,
			};
		},
	};
}

function dedupeCapabilities(
	capabilities: IndexedCapability[],
): IndexedCapability[] {
	const best = new Map<string, IndexedCapability>();
	for (const capability of capabilities) {
		const existing = best.get(capability.capId);
		if (!existing || capability.score > existing.score) {
			best.set(capability.capId, capability);
		}
	}
	return [...best.values()].sort((a, b) => b.score - a.score);
}

export type Retriever = ReturnType<typeof createRetriever>;
