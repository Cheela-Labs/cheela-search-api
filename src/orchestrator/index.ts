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

	// ---- Evolution ---------------------------------------------------------

	const hypotheses = await traced("orchestrator.evolution", () =>
		deps.evolution.expand(query, classification, signal),
	);

	// ---- Retrieval ---------------------------------------------------------

	const retrieval = await traced("orchestrator.retrieve", () =>
		deps.retriever.retrieve(hypotheses, {
			intent,
			entities: classification.entities,
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

	let results = retrieval.documents.map((document) =>
		toResult(query, document),
	);

	const capabilities = selectCapabilities(
		retrieval.capabilities,
		intent,
		retrieval.documents[0]?.fusedScore ?? 0,
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
		followUp: context.followUp,
		intent: {
			intent: classification.intent,
			confidence: classification.confidence,
			entities: classification.entities,
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
