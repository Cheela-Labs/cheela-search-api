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
		await expect(response.json()).resolves.toMatchObject({ status: "ok" });
	});

	it("rejects an empty query before opening a stream", async () => {
		const response = await app.request("/search?q=%20%20");
		expect(response.status).toBe(400);
		expect(response.headers.get("content-type")).toContain("application/json");
	});

	it("answers in the event contract, not with a bare status code", async () => {
		const response = await app.request("/search?q=anything");

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");

		const events = parseFrames(await response.text());

		// The surface has to be able to tell "not built yet" from "your query
		// found nothing", and only the first of those is an error event.
		expect(events.map((event) => event.type)).toEqual(["error", "done"]);
		expect(events[0]).toMatchObject({ type: "error" });
	});
});
