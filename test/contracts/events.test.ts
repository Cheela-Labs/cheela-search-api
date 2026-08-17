import { describe, expect, it } from "vitest";
import {
	type CheelaEvent,
	canonicalize,
	EVENT_VERSION,
	envelope,
	sign,
	verify,
} from "../../src/contracts/events.js";

const KEY = "a-test-signing-key-of-sufficient-length";

/** Typed as the variant, not the union, so the reordering test can read its fields. */
const searchExecuted = (): Extract<CheelaEvent, { type: "SearchExecuted" }> =>
	envelope({
		type: "SearchExecuted" as const,
		query: "australian wildfire",
		normalizedQuery: "australian wildfire",
		intent: "event" as const,
		hypotheses: ["australian wildfire", "black summer fires"],
		resultUrls: ["https://example.com/a"],
		servedFrom: "index" as const,
		latencyMs: 412,
	});

describe("canonicalize", () => {
	it("orders keys so the same event always signs to the same bytes", () => {
		// Without this, two producers that agree on the event disagree on the
		// signature, and the consumer rejects work that was never forged.
		expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
		expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
	});

	it("orders nested keys too", () => {
		expect(canonicalize({ outer: { z: 1, a: 2 } })).toBe(
			'{"outer":{"a":2,"z":1}}',
		);
	});

	it("preserves array order, which is data rather than layout", () => {
		expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
	});

	it("drops undefined rather than emitting it", () => {
		expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
	});
});

describe("signing", () => {
	it("round-trips a valid event", () => {
		const event = searchExecuted();
		const result = verify(JSON.stringify(event), sign(event, KEY), KEY);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.event.type).toBe("SearchExecuted");
			expect(result.event.version).toBe(EVENT_VERSION);
		}
	});

	it("verifies regardless of key order on the wire", () => {
		// The producer serialises with JSON.stringify and the consumer cannot
		// assume anything about property order across versions or runtimes. If
		// verification depended on it, an upgrade would reject its own events.
		const event = searchExecuted();
		const signature = sign(event, KEY);
		const reordered = JSON.stringify({
			latencyMs: event.latencyMs,
			type: event.type,
			id: event.id,
			version: event.version,
			occurredAt: event.occurredAt,
			query: event.query,
			normalizedQuery: event.normalizedQuery,
			intent: event.intent,
			hypotheses: event.hypotheses,
			resultUrls: event.resultUrls,
			servedFrom: event.servedFrom,
		});

		expect(verify(reordered, signature, KEY).ok).toBe(true);
	});

	it("rejects a tampered payload", () => {
		// The attack this exists for: the consumer of these events fetches URLs.
		// Rewriting resultUrls is how you make the crawler fetch what you choose.
		const event = searchExecuted();
		const signature = sign(event, KEY);
		const tampered = JSON.stringify({
			...event,
			resultUrls: ["http://169.254.169.254/computeMetadata/v1/"],
		});

		expect(verify(tampered, signature, KEY)).toEqual({
			ok: false,
			reason: "bad-signature",
		});
	});

	it("rejects an event signed with another key", () => {
		const event = searchExecuted();
		expect(
			verify(JSON.stringify(event), sign(event, "other-key"), KEY),
		).toEqual({ ok: false, reason: "bad-signature" });
	});

	it("rejects an unsigned entry", () => {
		const event = searchExecuted();
		expect(verify(JSON.stringify(event), undefined, KEY)).toEqual({
			ok: false,
			reason: "unsigned",
		});
	});

	it("rejects a signature of the wrong length without throwing", () => {
		// timingSafeEqual throws on a length mismatch, and a throw inside the
		// consumer loop is an unhandled rejection that stops indexing.
		const event = searchExecuted();
		expect(verify(JSON.stringify(event), "abcd", KEY)).toEqual({
			ok: false,
			reason: "bad-signature",
		});
	});

	it("rejects a body that is not JSON", () => {
		expect(verify("{not json", "00".repeat(32), KEY)).toEqual({
			ok: false,
			reason: "malformed",
		});
	});

	it("rejects a correctly signed event that does not match the schema", () => {
		// Signed by us but wrong shape — a producer bug rather than an attack, and
		// it must not reach a handler that assumes the fields are there.
		const bogus = { version: EVENT_VERSION, type: "SearchExecuted" };
		const signature = sign(bogus as unknown as CheelaEvent, KEY);
		expect(verify(JSON.stringify(bogus), signature, KEY)).toEqual({
			ok: false,
			reason: "malformed",
		});
	});
});

describe("envelope", () => {
	it("stamps a version, a unique id and a timestamp", () => {
		const one = envelope({
			type: "CrawlCompleted" as const,
			url: "https://a",
			outcome: "indexed" as const,
			reason: "",
		});
		const two = envelope({
			type: "CrawlCompleted" as const,
			url: "https://a",
			outcome: "indexed" as const,
			reason: "",
		});

		expect(one.version).toBe(EVENT_VERSION);
		expect(one.occurredAt).toBeGreaterThan(0);
		// Distinct ids for identical payloads, so redelivery is distinguishable
		// from a genuine second occurrence.
		expect(one.id).not.toBe(two.id);
	});

	it("carries no identity on SearchExecuted", () => {
		// Structural privacy: the field does not exist, so no consumer can read
		// it and no breach can leak it.
		const event = searchExecuted();
		expect(event).not.toHaveProperty("userId");
		expect(event).not.toHaveProperty("sessionId");
		expect(event).not.toHaveProperty("ip");
	});
});
