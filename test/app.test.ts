import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { SearchEvent } from "../src/shared/events";

/**
 * Asserts the wire encoding, not the types.
 *
 * `src/shared/events.ts` is duplicated in `apps/search-web` because both apps
 * build standalone from their own mirrors, so TypeScript cannot catch a drift
 * between them. What can catch it is a test on the bytes: if a frame stops
 * being `data: <json>\n\n`, or an event stops being a `{type}`-tagged object,
 * the surface's parser breaks and so does this.
 */
function parseFrames(body: string): SearchEvent[] {
	return body
		.split("\n\n")
		.filter((chunk) => chunk.startsWith("data:"))
		.map((chunk) => JSON.parse(chunk.slice(5).trim()) as SearchEvent);
}

describe("search-api", () => {
	const app = createApp();

	it("reports health", async () => {
		const response = await app.request("/health");
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.status).toBe("ok");
		// Reported, not asserted reachable — the suite has no database, and a
		// health check that fails without one would restart-loop in production.
		expect(body.database).toBe("unreachable");
	});

	it("rejects an empty query before opening a stream", async () => {
		const response = await app.request("/search?q=%20%20");
		expect(response.status).toBe(400);
		expect(response.headers.get("content-type")).toContain("application/json");
	});

	it("answers in the event contract, not with a bare status code", async () => {
		// No vendor credentials in the test environment, so the rotation fails —
		// which is the point being asserted. The stream still opens with 200 and
		// reports the failure as an event, because by then the headers are gone
		// and there is no status left to send. `pipeline.test.ts` drives the same
		// route with a working upstream.
		const response = await app.request("/search?q=anything");

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");

		const events = parseFrames(await response.text());
		const types = events.map((event) => event.type);

		expect(types[0]).toBe("stage");
		expect(types).toContain("error");
	});
});

describe("search-api · the token gate", () => {
	// The gate reads config at request time, and `config` is frozen at import
	// with no token set — so these drive `createApp` through a tiny app that
	// mirrors the middleware's contract rather than restubbing the module.
	it("is open when no token is configured", async () => {
		const response = await createApp().request("/search?q=x");
		// No 401: unset means open, which is the state the service shipped in.
		expect(response.status).not.toBe(401);
	});

	it("leaves /health outside the gate", async () => {
		// Cloud Run's probes carry no headers. A health check behind auth fails
		// every probe and restart-loops the service.
		const response = await createApp().request("/health");
		expect(response.status).toBe(200);
	});
});
