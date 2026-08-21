import { randomUUID } from "node:crypto";
import {
	type CheelaEvent,
	envelope,
	keyFor,
	STREAMS,
} from "@cheela/search-core";
import type {
	EntityRef,
	SearchRequest,
	SearchResponse,
} from "../contracts/search.js";
import type { Context } from "../services/context/index.js";
import type { Evolution } from "../services/evolution/index.js";
import type { Generator } from "../services/generator/index.js";
import type { Classifier } from "../services/intent/index.js";
import { actOn } from "../services/intent/index.js";
import { answerConversion } from "../services/intent/units.js";
import { applyEntitySignals } from "../services/ranking/entity-aware.js";
import {
	markCited,
	selectCapabilities,
	toResult,
} from "../services/ranking/index.js";
import type { Retriever } from "../services/retriever/index.js";
import { logger } from "../shared/logger.js";
import { traced } from "../shared/telemetry.js";

/**
 * The Query Orchestrator: the lifecycle both specifications describe, in one
 * place and in that order.
 *
 *     Context → Intent → Evolution → Retrieve → Rank → Generate → Return
 *
 * It owns no I/O of its own. Everything it needs arrives as a dependency, so
 * the sequence is readable as a sequence and each stage can be tested without
 * standing up the ones around it.
 *
 * Two properties hold throughout:
 *
 * 1. **No stage may fail the search.** Each one degrades to a defined neutral
 *    outcome and records its name in `meta.degraded`. A search engine that
 *    returns nothing because its classifier was slow is worse than one that
 *    returns unclassified results.
 * 2. **Indexing never blocks the answer.** Everything learned is published to
 *    a stream and consumed elsewhere; the user waits for none of it.
 */

export type OrchestratorDeps = {
	classify: Classifier;
	context: Context;
	evolution: Evolution;
	retriever: Retriever;
	generator: Generator;
	entitiesFor?: (names: string[]) => Promise<EntityRef[]>;
	publish?: (stream: string, event: CheelaEvent) => void;
};

export async function runSearch(
	request: SearchRequest,
	deps: OrchestratorDeps,
	signal?: AbortSignal,
): Promise<SearchResponse> {
	const started = Date.now();
	const degraded: string[] = [];

	// ---- Context -----------------------------------------------------------

	const context = await traced("orchestrator.context", () =>
		deps.context.resolve(request.query, request.sessionId, signal),
	).catch((error) => {
		logger.warn({ error: (error as Error).message }, "context engine failed");
		degraded.push("context");
		return {
			sessionId: request.sessionId ?? randomUUID(),
			followUp: false,
			resolved: request.query,
			session: { id: request.sessionId ?? randomUUID(), turns: [] },
		};
	});

	const query = context.resolved;

	// ---- Intent ------------------------------------------------------------

	const classification = await traced("orchestrator.intent", () =>
		deps.classify(query, signal),
	);
	const intent = actOn(classification);
	if (classification.confidence === 0) degraded.push("intent");

	// ---- Arithmetic --------------------------------------------------------
	//
	// A conversion is the one query this engine can answer completely on its
	// own, and everything below this line makes it worse. Retrieval has nothing
	// to find; the generator, handed news articles and asked about kilograms,
	// writes an apology. Production answered "1 kg in pound" with "I am sorry,
	// but the provided sources do not contain information about converting
	// kilograms to pounds. They focus on news related to an earthquake in
	// Colombia" — three model calls, four index queries and up to two paid
	// provider calls, to be wrong.
	//
	// `results` is empty on purpose. The design's own line for this module is
	// "COMPUTED LOCALLY · NO SOURCES NEEDED", and a citation here would claim
	// somebody said this rather than that it is true. The surface renders the
	// converter from the query text; the sentence is here so a client that is
	// not our surface still gets the number.
	if (classification.conversion) {
		return {
			answer: answerConversion(classification.conversion),
			results: [],
			capabilities: [],
			citations: [],
			followUp: context.followUp,
			intent: {
				intent: classification.intent,
				confidence: classification.confidence,
				entities: classification.entities,
			},
			entities: [],
			sessionId: context.sessionId,
			meta: {
				latencyMs: Date.now() - started,
				// Nothing retrieved it. "index" is the least wrong of the three
				// the contract allows, and it is read by the crawl scheduler as a
				// demand signal — reporting "external" would ask the crawler to go
				// and fetch pages about arithmetic.
				servedFrom: "index",
				hypotheses: [],
				degraded,
			},
		};
	}

	// ---- Evolution ---------------------------------------------------------

	const hypotheses = await traced("orchestrator.evolution", () =>
		deps.evolution.expand(query, classification, signal),
	);

	// ---- Retrieval ---------------------------------------------------------

	const retrieval = await traced("orchestrator.retrieve", () =>
		deps.retriever.retrieve(hypotheses, {
			intent,
			entities: classification.entities,
			// Passed so retrieval can notice that a navigational query came back
			// without the one domain it was asking for. It changes when stage B
			// runs and nothing else — not the hybrid query, not the ranking.
			officialDomain: classification.navigation?.officialDomain,
			signal,
		}),
	);
	degraded.push(...retrieval.degraded);

	// ---- Ranking -----------------------------------------------------------

	// The graph lookup's failure costs the entity list, not the answer.
	let entities: EntityRef[] = [];
	try {
		entities = (await deps.entitiesFor?.(classification.entities)) ?? [];
	} catch (error) {
		logger.warn({ error: (error as Error).message }, "entity lookup failed");
		degraded.push("graph");
	}

	// The Entity-Aware Ranking Layer.
	//
	// After retrieval and after reranking, changing neither. Placed here rather
	// than inside the retriever because both result sets are already merged at
	// this point and because entities have just been resolved above — and, more
	// importantly, it must run *before* generation. Citations are positional:
	// the generator numbers sources by array index and `extractCitations`
	// resolves `[n]` back to `results[n - 1]`, so reordering afterwards would
	// silently repoint every citation in the answer.
	const ranked = applyEntitySignals(retrieval.documents, {
		intent,
		entity: classification.navigation?.entity,
		officialDomain: classification.navigation?.officialDomain,
		confidence: classification.confidence,
	});

	let results = ranked.map((document) => toResult(query, document));

	const capabilities = selectCapabilities(
		retrieval.capabilities,
		intent,
		ranked[0]?.fusedScore ?? 0,
	);

	// ---- Generation --------------------------------------------------------

	const generated = await traced("orchestrator.generate", () =>
		deps.generator.generate({
			query,
			intent,
			results,
			capabilities: retrieval.capabilities,
			entities,
			signal,
		}),
	);

	results = markCited(
		results,
		new Set(generated.citations.map((citation) => citation.resultId)),
	);

	// ---- Learn -------------------------------------------------------------

	const latencyMs = Date.now() - started;
	const { normalized } = keyFor(query);

	// Fire and forget, after the answer is assembled. Nothing below this line
	// is allowed to be on the user's critical path.
	deps.publish?.(
		STREAMS.search,
		envelope({
			type: "SearchExecuted" as const,
			query,
			normalizedQuery: normalized,
			intent,
			hypotheses: hypotheses.map((hypothesis) => hypothesis.query),
			resultUrls: results.map((result) => result.url),
			servedFrom: retrieval.servedFrom,
			latencyMs,
		}),
	);

	void deps.context
		.record(context.session, {
			query: request.query,
			resolved: query,
			intent,
			entities: classification.entities,
			at: Date.now(),
		})
		.catch(() => {});

	return {
		answer: generated.answer,
		results,
		capabilities,
		citations: generated.citations,
		comparison: generated.comparison,
		followUp: context.followUp,
		intent: {
			intent: classification.intent,
			confidence: classification.confidence,
			entities: classification.entities,
			// Already computed by the structural pass and already used for
			// ranking; sent so a navigational query can render the destination it
			// resolved to rather than making the surface guess which result was
			// the official one.
			officialDomain: classification.navigation?.officialDomain,
			officialUrl: classification.navigation?.officialUrl,
		},
		entities,
		sessionId: context.sessionId,
		meta: {
			latencyMs,
			servedFrom: retrieval.servedFrom,
			hypotheses: hypotheses.map((hypothesis) => hypothesis.query),
			degraded: [...new Set(degraded)],
		},
	};
}
