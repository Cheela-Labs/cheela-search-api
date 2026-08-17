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
 * phase is mostly `sigmoid(logit)`, which is a relevance probability. Without
 * it the first-phase score is a sum of seven bounded terms with no upper bound
 * that means anything, so it is combined with *how many* results cleared a
 * floor: one good hit is a lucky match, six is an index that knows this topic.
 */
export function indexConfidence(
	documents: { fusedScore: number; features: Record<string, number> }[],
	reranked: boolean,
	topScore: number,
): number {
	if (documents.length === 0) return 0;

	const depth = Math.min(1, documents.length / 6);
	if (reranked) {
		// The reranked score is already 0..1 and already about this query.
		return Math.min(1, topScore) * (0.6 + 0.4 * depth);
	}
	// 3.0 is a full house on the un-reranked scale: seven terms, most of which
	// are neutral for a typical document.
	return Math.min(1, topScore / 3) * (0.5 + 0.5 * depth);
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
					hypotheses.map(async (hypothesis) => ({
						hypothesis,
						result: await deps.index.search(hypothesis.query, {
							intent: options.intent,
							entities: options.entities,
							limit,
							// Rerank only the query as typed. The cross-encoder is the
							// most expensive thing in the budget and running it on four
							// hypotheses would spend it four times to reorder lists that
							// RRF is about to merge anyway.
							rerank: hypothesis.source === "original",
							signal: options.signal,
						}),
					})),
				),
			);

			if (stageA.some((entry) => entry.result.failed)) {
				degraded.push("vespa");
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

			const topScore = stageA[0]?.result.documents[0]?.score ?? 0;
			const confidence = indexConfidence(
				indexed.map((entry) => ({
					fusedScore: entry.score,
					features: entry.item.features,
				})),
				true,
				topScore,
			);

			const documents = indexed.map((entry) =>
				fromIndex(entry.item, entry.score, entry.agreement),
			);

			if (confidence >= config.INDEX_CONFIDENCE_THRESHOLD) {
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
			const seen = new Set(documents.map((document) => document.url));
			const combined = [
				...documents,
				...fusedExternal
					.filter((entry) => !seen.has(entry.item.url))
					.map((entry) =>
						fromExternal(entry.item, entry.score, entry.agreement),
					),
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
