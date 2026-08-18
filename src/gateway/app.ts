import type { VespaClient } from "@cheela/search-core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
	indexDocumentSchema,
	registerCapabilitySchema,
	searchRequestSchema,
} from "../contracts/search.js";
import { databaseReachable } from "../infra/db/pool.js";
import { cacheStats, rateLimit } from "../infra/redis/cache.js";
import { redisReachable } from "../infra/redis/client.js";
import { type OrchestratorDeps, runSearch } from "../orchestrator/index.js";
import type { Capabilities } from "../services/capabilities/index.js";
import type { Indexer } from "../services/indexer/index.js";
import type { Graph } from "../services/knowledge-graph/index.js";
import { config } from "../shared/config.js";
import { logger } from "../shared/logger.js";

/**
 * The API Gateway.
 *
 * Its whole job is the edge: CORS, the token gate, rate limiting, request
 * validation, and turning a thrown error into a status code. It contains no
 * search logic — everything below `runSearch` is the orchestrator's.
 */

export type GatewayDeps = OrchestratorDeps & {
	indexer: Indexer;
	capabilities: Capabilities;
	graph: Graph;
	vespa: VespaClient;
};

export function createApp(deps: GatewayDeps) {
	const app = new Hono();

	app.use(
		"/*",
		cors({
			origin: config.ALLOWED_ORIGINS,
			// POST, because the TDS's /search takes a body. The session id has to
			// travel with the query and a GET would put it in a URL, where it
			// lands in every access log between here and the browser.
			allowMethods: ["GET", "POST", "OPTIONS"],
			allowHeaders: ["content-type", "authorization"],
		}),
	);

	/**
	 * Deliberately outside the token gate and deliberately always 200.
	 *
	 * Cloud Run's startup and liveness probes carry no headers, so a health
	 * check behind auth fails every probe and restart-loops the service. And
	 * reporting a dependency as *unhealthy* rather than *unreachable* would let
	 * a brief Vespa blip restart a container that was serving fine from cache —
	 * turning a degradation into an outage.
	 */
	app.get("/health", async (context) => {
		const [database, redis, vespa] = await Promise.all([
			databaseReachable(),
			redisReachable(),
			deps.vespa.reachable(),
		]);

		return context.json({
			status: "ok",
			service: "search-api",
			database: database ? "reachable" : "unreachable",
			redis: redis ? "reachable" : "unreachable",
			vespa: vespa ? "reachable" : "unreachable",
			caches: cacheStats(),
		});
	});

	/**
	 * The token gate.
	 *
	 * Not authentication, and it does not pretend to be: it is a bearer secret
	 * that stops a public URL from being a public search engine. Retrieval
	 * spends money — an external call plus, eventually, a page fetch each —
	 * so an open endpoint is somebody else's queries on our quota.
	 */
	app.use("/search", authenticate);
	app.use("/index/*", authenticate);
	app.use("/capabilities/*", authenticate);
	app.use("/entities/*", authenticate);

	async function authenticate(
		context: Parameters<Parameters<typeof app.use>[1]>[0],
		next: () => Promise<void>,
	) {
		const presented = context.req.header("authorization");
		if (presented === `Bearer ${config.SEARCH_API_TOKEN}`) return next();

		logger.warn(
			{
				mode: config.SEARCH_API_TOKEN_MODE,
				path: context.req.path,
				presented: presented ? "mismatched" : "absent",
				agent: context.req.header("user-agent")?.slice(0, 60),
			},
			"token rejected",
		);

		// `observe` exists for the window between deploying the token here and
		// setting it on the caller. It never applies to the write routes: a
		// mode meant to avoid breaking readers must not leave the index open.
		const readOnly = context.req.path === "/search";
		if (config.SEARCH_API_TOKEN_MODE === "observe" && readOnly) return next();

		return context.json({ error: "Unauthorized" }, 401);
	}

	app.post("/search", async (context) => {
		const body = await context.req.json().catch(() => null);
		const parsed = searchRequestSchema.safeParse(body);
		if (!parsed.success) {
			return context.json(
				{ error: "Invalid request", detail: parsed.error.issues[0]?.message },
				400,
			);
		}

		const caller =
			context.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
			parsed.data.sessionId ??
			"anonymous";
		const limit = await rateLimit(
			caller,
			config.RATE_LIMIT_MAX,
			config.RATE_LIMIT_WINDOW_MS,
		);
		if (!limit.allowed) {
			return context.json({ error: "Too many requests" }, 429);
		}

		try {
			const response = await runSearch(
				parsed.data,
				deps,
				context.req.raw.signal,
			);
			return context.json(response);
		} catch (error) {
			// The orchestrator degrades rather than throwing, so reaching here
			// means something outside the stage contracts broke.
			logger.error(
				{ error: (error as Error).message, stack: (error as Error).stack },
				"search failed",
			);
			return context.json({ error: "Search failed" }, 500);
		}
	});

	app.post("/index/document", async (context) => {
		const body = await context.req.json().catch(() => null);
		const parsed = indexDocumentSchema.safeParse(body);
		if (!parsed.success) {
			return context.json(
				{ error: "Invalid document", detail: parsed.error.issues[0]?.message },
				400,
			);
		}

		try {
			const outcome = await deps.indexer.index(parsed.data);
			return context.json(outcome, outcome.status === "failed" ? 502 : 200);
		} catch (error) {
			logger.error({ error: (error as Error).message }, "indexing failed");
			return context.json({ error: "Indexing failed" }, 500);
		}
	});

	app.post("/capabilities/register", async (context) => {
		const body = await context.req.json().catch(() => null);
		const parsed = registerCapabilitySchema.safeParse(body);
		if (!parsed.success) {
			return context.json(
				{
					error: "Invalid capability",
					detail: parsed.error.issues[0]?.message,
				},
				400,
			);
		}

		try {
			const registered = await deps.capabilities.register(parsed.data);
			return context.json(registered, 201);
		} catch (error) {
			logger.error({ error: (error as Error).message }, "registration failed");
			return context.json({ error: "Registration failed" }, 500);
		}
	});

	app.get("/entities/:id", async (context) => {
		try {
			const entity = await deps.graph.get(context.req.param("id"));
			if (!entity) return context.json({ error: "Not found" }, 404);
			return context.json(entity);
		} catch (error) {
			logger.error({ error: (error as Error).message }, "entity lookup failed");
			return context.json({ error: "Lookup failed" }, 500);
		}
	});

	app.notFound((context) => context.json({ error: "Not found" }, 404));

	return app;
}
