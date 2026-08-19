import { STREAMS } from "@cheela/search-core";
import type { EntityRef } from "./contracts/search.js";
import { createApp, type GatewayDeps } from "./gateway/app.js";
import { pool } from "./infra/db/pool.js";
import { egress } from "./infra/egress/index.js";
import { model } from "./infra/model/index.js";
import { createCache } from "./infra/redis/cache.js";
import { publish } from "./infra/redis/streams.js";
import { vespa } from "./infra/vespa/client.js";
import { createCapabilities } from "./services/capabilities/index.js";
import { createContext, type Session } from "./services/context/index.js";
import { createEntityRegistry } from "./services/entity-registry/index.js";
import { createEvolution } from "./services/evolution/index.js";
import { createGenerator } from "./services/generator/index.js";
import { createClassifier } from "./services/intent/index.js";
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
 * The Entity Registry, wired once and shared by every request.
 *
 * A module-level singleton rather than a per-request build, because the whole
 * point is that it is already in memory when the intent engine asks. Written by
 * the Console (ADR-003); this side never writes.
 */
export const entityRegistry = createEntityRegistry({ pool });

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
		// The registry is consulted before the model call, so a known name never
		// reaches an LLM to be guessed at. That is what makes `redis`, `stripe`
		// and `vercel` get the same answer as each other instead of three
		// different ones.
		classify: createClassifier(model, entityRegistry),

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

		capabilities: createCapabilities({ pool }),
		graph,
		vespa,
	};
}

export { createApp, STREAMS };
