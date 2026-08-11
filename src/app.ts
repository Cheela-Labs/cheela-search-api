import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./shared/config";
import { frame } from "./shared/events";

/**
 * The query plane.
 *
 * Two routes today. `/health` is real. `/search` speaks the event contract and
 * says, in that contract, that it cannot answer yet — see PLAN.md, Phase 0.
 *
 * That stub is deliberate and it is not the same thing as a route that does
 * nothing. `apps/search-web` can be pointed at this service right now: it
 * opens the stream, reads a frame it understands, and renders the reason on
 * the surface where somebody will see it. The alternative — leaving the route
 * out until it works — means the first time the two halves are wired together
 * is also the first time anything about the wiring is exercised.
 */
export function createApp() {
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
		const query = (context.req.query("q") ?? "").trim();
		if (!query) {
			return context.json({ error: "Missing query" }, 400);
		}

		// 200 with an error frame rather than a 501, so the surface renders the
		// sentence instead of "Search failed with 501". The client only learns
		// what went wrong if the answer arrives in the language it reads.
		return new Response(
			frame({
				type: "error",
				message:
					"The query plane is not implemented yet. Phase 0 in apps/search-api/PLAN.md builds it; until then apps/search-web answers from its own fixture corpus.",
			}) + frame({ type: "done" }),
			{
				headers: {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-cache, no-transform",
					// Proxies that buffer defeat the point of streaming this at all,
					// and the whole latency argument in the architecture doc depends
					// on frames arriving as they are produced.
					"x-accel-buffering": "no",
				},
			},
		);
	});

	return app;
}
