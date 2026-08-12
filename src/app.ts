import { Hono } from "hono";
import { cors } from "hono/cors";
import { composer } from "./domain/compose";
import { type PipelineDeps, runPipeline } from "./domain/pipeline";
import { egress } from "./infra/egress";
import { upstream } from "./infra/upstream";
import { config } from "./shared/config";
import { frame, type SearchEvent } from "./shared/events";

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

	app.get("/health", (context) =>
		context.json({ status: "ok", plane: "query", phase: "pre-0" }),
	);

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
