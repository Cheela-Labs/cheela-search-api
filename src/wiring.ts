import { STREAMS } from "@cheela/search-core";
import type { EntityRef } from "./contracts/search.js";
import { createApp, type GatewayDeps } from "./gateway/app.js";
import { pool } from "./infra/db/pool.js";
import { egress } from "./infra/egress/index.js";
import { archiveOrSkip } from "./infra/gcs/index.js";
import { model } from "./infra/model/index.js";
import { createCache } from "./infra/redis/cache.js";
import { publish } from "./infra/redis/streams.js";
import { vespa } from "./infra/vespa/client.js";
import { createCapabilities } from "./services/capabilities/index.js";
import { createContext, type Session } from "./services/context/index.js";
import { createEvolution } from "./services/evolution/index.js";
import { createGenerator } from "./services/generator/index.js";
import { createIndexer } from "./services/indexer/index.js";
import { createClassifier } from "./services/intent/index.js";
import { createExtractor } from "./services/knowledge-graph/extract.js";
import { createGraph } from "./services/knowledge-graph/index.js";
import { createRetriever } from "./services/retriever/index.js";
import {
	type Candidate,
	createAnySearch,
	createTavily,
} from "./services/retriever/providers.js";
import { createIndexStage } from "./services/retriever/vespa-stage.js";
import { config } from "./shared/config.js";

/**
 * Where the production dependency graph is assembled.
 *
 * Kept out of the gateway and out of every service so the wiring is one
 * readable file, and so a test can build the same graph with two things
 * swapped without importing a module that opens a socket at import time.
 */
/**
 * The indexer, wired once.
 *
 * Exported so `worker.ts` uses *this* rather than assembling its own. It
 * previously built `createIndexer({ pool, vespa, egress })` — no `archive`, no
 * `extract` — and since the worker is where almost all indexing happens, that
 * meant the crawl path silently archived no HTML and extracted no entities.
 * Both features were tested, both were reported working, and both only ever ran
 * for `POST /index/document`.
 *
 * Nothing about that bug was visible in a type: the dependencies are optional
 * because a test may omit them, so the second wiring compiled and ran and just
 * did less. One builder is the fix — the two call sites can no longer disagree.
 */
export function buildIndexer() {
	// Runs off the request path, so its latency is nobody's problem and its cost
	// is one model call per indexed document rather than per query.
	const extractor = createExtractor({ model });

	return createIndexer({
		pool,
		vespa,
		egress,
		archive: archiveOrSkip,
		extract: (text, title) => extractor.extract(text, title),
	});
}

/** The graph, wired once. Same reason. */
export function buildGraph() {
	return createGraph({
		pool,
		cache: createCache<EntityRef[]>("entity", config.ENTITY_CACHE_TTL_MS),
		vespa,
	});
}

export function buildDeps(): GatewayDeps {
	const graph = buildGraph();
	const index = createIndexStage(vespa);

	return {
		classify: createClassifier(model),

		context: createContext({
			model,
			sessions: createCache<Session>(
				"session",
				config.SESSION_TTL_SECONDS * 1000,
			),
		}),

		evolution: createEvolution({
			model,
			// Both read the index, and both are allowed to fail: they add
			// hypotheses, and a query with one hypothesis is still a query.
			remembered: (query) => index.remembered(query),
			aliases: (entities) => graph.aliasesFor(entities),
		}),

		retriever: createRetriever({
			index,
			providers: [
				createTavily(config.TAVILY_API_KEY, egress),
				createAnySearch(config.ANYSEARCH_API_KEY, egress),
			],
			queryCache: createCache<Candidate[]>("query", config.QUERY_CACHE_TTL_MS),
		}),

		generator: createGenerator({ model }),

		entitiesFor: (names) => graph.resolve(names),

		publish: (stream, event) => {
			void publish(stream, event);
		},

		indexer: buildIndexer(),

		capabilities: createCapabilities({ pool, vespa }),
		graph,
		vespa,
	};
}

export { createApp, STREAMS };
