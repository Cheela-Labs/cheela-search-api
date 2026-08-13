import { Hono } from "hono";
import { cors } from "hono/cors";
import { composer } from "./domain/compose";
import { type PipelineDeps, runPipeline } from "./domain/pipeline";
import { databaseReachable } from "./infra/db/pool";
import { egress } from "./infra/egress";
import { upstream } from "./infra/upstream";
import { config } from "./shared/config";
import { frame, type SearchEvent } from "./shared/events";
import { logger } from "./shared/logger";

/** Longer than any sensible query, short enough to bound what reaches a model. */
const MAX_QUERY = 400;

/**
 * The query plane.
 *
 * `/search` runs the real pipeline and streams its events; `apps/search-web`
 * consumes exactly this contract, so pointing the surface here is the
 * integration test rather than a mock of one.
 *
 * The response is a stream that has already begun by the time most things can
 * fail, which is why the pipeline reports failure as an `error` *event* and
 * this handler never throws past the first frame. There is no status code left
 * to send once the headers are out.
 */
export function createApp(overrides: Partial<PipelineDeps> = {}) {
	// The same injection seam as the egress client's: production defaults that
	// nothing but a test overrides, as constructor parameters rather than
	// configuration, so no environment variable can swap a provider on a running
	// service.
	const deps: PipelineDeps = {
		upstream: overrides.upstream ?? upstream,
		egress: overrides.egress ?? egress,
		composer: overrides.composer ?? composer,
		candidateLimit: overrides.candidateLimit,
		passageLimit: overrides.passageLimit,
	};

	const app = new Hono();

	app.use(
		"/*",
		cors({
			origin: config.ALLOWED_ORIGINS,
			allowMethods: ["GET", "OPTIONS"],
		}),
	);

	// The database result is *reported*, never a failure condition. Cloud Run
	// restarts a container whose health check fails, so coupling liveness to a
	// dependency turns a brief database blip into a restart loop that takes the
	// service down harder than the blip would have. This says what it sees and
	// stays 200.
	app.get("/health", async (context) =>
		context.json({
			status: "ok",
			plane: "query",
			database: (await databaseReachable()) ? "reachable" : "unreachable",
		}),
	);

	/**
	 * The token gate.
	 *
	 * `/health` is deliberately outside it: Cloud Run's startup and liveness
	 * probes carry no headers, and a health check behind auth fails every probe
	 * and restart-loops the service.
	 *
	 * Retrieval spends money — a query costs an upstream call plus six to ten
	 * page fetches — so an open endpoint is somebody else's queries on our
	 * quota. This does not pretend to be authentication; it is a bearer secret
	 * that stops a public URL from being a public search engine.
	 */
	app.use("/search", async (context, next) => {
		if (!config.SEARCH_API_TOKEN) return next();

		const presented = context.req.header("authorization");
		const ok = presented === `Bearer ${config.SEARCH_API_TOKEN}`;
		if (ok) return next();

		// Logged either way. In `enforce` this is the abuse signal worth counting;
		// in `observe` it is the whole point — it says whether the caller is ready
		// before refusing anything.
		logger.warn(
			{
				mode: config.SEARCH_API_TOKEN_MODE,
				presented: presented ? "mismatched" : "absent",
				agent: context.req.header("user-agent")?.slice(0, 60),
			},
			"search token rejected",
		);

		if (config.SEARCH_API_TOKEN_MODE === "observe") return next();
		return context.json({ error: "Unauthorized" }, 401);
	});

	app.get("/search", (context) => {
		const query = (context.req.query("q") ?? "").trim().slice(0, MAX_QUERY);
		if (!query) {
			return context.json({ error: "Missing query" }, 400);
		}

		const encoder = new TextEncoder();
		const signal = context.req.raw.signal;

		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				// The client aborts on every follow-up query, so a cancelled stream
				// is the normal way this ends. Once cancelled, `enqueue` and `close`
				// both throw, and letting that escape turns routine behaviour into
				// an unhandled rejection in the log.
				const send = (event: SearchEvent): boolean => {
					if (signal.aborted) return false;
					try {
						controller.enqueue(encoder.encode(frame(event)));
						return true;
					} catch {
						return false;
					}
				};

				try {
					for await (const event of runPipeline(query, deps, signal)) {
						if (!send(event)) break;
					}
				} catch (error) {
					send({
						type: "error",
						message: error instanceof Error ? error.message : "Search failed",
					});
				} finally {
					try {
						controller.close();
					} catch {
						// Already cancelled by the disconnect.
					}
				}
			},
		});

		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache, no-transform",
				// Proxies that buffer defeat the point of streaming this at all,
				// and the latency argument in PLAN.md depends on frames arriving as
				// they are produced.
				"x-accel-buffering": "no",
			},
		});
	});

	return app;
}
