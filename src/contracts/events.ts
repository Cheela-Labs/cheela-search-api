import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { intentSchema } from "./intent.js";

/**
 * The internal event contract.
 *
 * Six events, exactly the set both specification documents name. They travel
 * on Redis Streams and are consumed by the worker, which is a different
 * process on a different Cloud Run service — so they are a wire format, not a
 * function call, and they are versioned and signed like one.
 *
 * ### Why signed
 *
 * The TDS asks for signed internal events and it is worth being precise about
 * what that buys, because "we have Redis auth" is a reasonable objection.
 * The consumer of these events *fetches URLs and feeds an index*. An attacker
 * who can write one stream entry — through a misconfigured Memorystore, a
 * leaked URL, or a future service that gets write access it should not have —
 * can otherwise make the crawler fetch an address of their choosing and index
 * text of their choosing. The signature makes the stream's contents provably
 * ours regardless of who can write to the stream.
 */

export const EVENT_VERSION = 1;

export const STREAMS = {
	search: "cheela:events:search",
	index: "cheela:events:index",
	graph: "cheela:events:graph",
	crawl: "cheela:events:crawl",
} as const;

const base = z.object({
	version: z.literal(EVENT_VERSION),
	id: z.string().min(1),
	occurredAt: z.number().int().positive(),
});

export const searchExecutedSchema = base.extend({
	type: z.literal("SearchExecuted"),
	// No user id and no session id. This event exists to teach the ranker what
	// people want, and that is an aggregate question; carrying identity here
	// would put it in a durable stream that four consumers read.
	query: z.string(),
	normalizedQuery: z.string(),
	intent: intentSchema,
	hypotheses: z.array(z.string()),
	resultUrls: z.array(z.string()),
	servedFrom: z.enum(["index", "external", "mixed"]),
	latencyMs: z.number().nonnegative(),
});

export const externalFetchedSchema = base.extend({
	type: z.literal("ExternalFetched"),
	provider: z.string(),
	query: z.string(),
	urls: z.array(z.string()),
});

export const documentIndexedSchema = base.extend({
	type: z.literal("DocumentIndexed"),
	docId: z.string(),
	url: z.string(),
	domain: z.string(),
	chunks: z.number().int().nonnegative(),
	/** True when this replaced an existing document rather than adding one. */
	replaced: z.boolean(),
});

export const entitiesExtractedSchema = base.extend({
	type: z.literal("EntitiesExtracted"),
	docId: z.string(),
	entities: z.array(
		z.object({
			name: z.string(),
			type: z.string(),
			confidence: z.number().min(0).max(1),
		}),
	),
	edges: z.array(
		z.object({
			source: z.string(),
			relation: z.string(),
			target: z.string(),
			confidence: z.number().min(0).max(1),
		}),
	),
});

export const capabilityRegisteredSchema = base.extend({
	type: z.literal("CapabilityRegistered"),
	capId: z.string(),
	domain: z.string(),
	invocationName: z.string(),
});

export const crawlCompletedSchema = base.extend({
	type: z.literal("CrawlCompleted"),
	url: z.string(),
	outcome: z.enum(["indexed", "duplicate", "refused", "failed"]),
	reason: z.string().default(""),
});

export const eventSchema = z.discriminatedUnion("type", [
	searchExecutedSchema,
	externalFetchedSchema,
	documentIndexedSchema,
	entitiesExtractedSchema,
	capabilityRegisteredSchema,
	crawlCompletedSchema,
]);

export type CheelaEvent = z.infer<typeof eventSchema>;
export type EventType = CheelaEvent["type"];

/** Fills in the envelope so callers only ever write the payload. */
export function envelope<T extends { type: EventType }>(
	payload: T,
): T & { version: typeof EVENT_VERSION; id: string; occurredAt: number } {
	return {
		...payload,
		version: EVENT_VERSION,
		id: randomUUID(),
		occurredAt: Date.now(),
	};
}

/**
 * Canonical JSON: keys sorted, so the same event signs to the same bytes no
 * matter which code path built it. Without this, two producers that agree on
 * the event disagree on the signature, and the consumer rejects valid work.
 */
export function canonicalize(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map(canonicalize).join(",")}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries
		.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
		.join(",")}}`;
}

export function sign(event: CheelaEvent, key: string): string {
	return createHmac("sha256", key).update(canonicalize(event)).digest("hex");
}

export type VerifyResult =
	| { ok: true; event: CheelaEvent }
	| { ok: false; reason: "malformed" | "unsigned" | "bad-signature" };

/**
 * Verifies and parses one stream entry.
 *
 * The signature is checked *before* the schema, and both are checked before
 * anything downstream sees a URL. Order matters here: parsing attacker-shaped
 * JSON is a smaller attack surface than parsing it and then acting on it, but
 * it is not zero, and there is no reason to do it for an entry we already know
 * is not ours.
 */
export function verify(
	body: string,
	signature: string | undefined,
	key: string,
): VerifyResult {
	if (!signature) return { ok: false, reason: "unsigned" };

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return { ok: false, reason: "malformed" };
	}

	const expected = createHmac("sha256", key)
		.update(canonicalize(parsed))
		.digest();
	const presented = Buffer.from(signature, "hex");
	// Length check first: timingSafeEqual throws on a length mismatch, and a
	// throw here would be an unhandled rejection in the consumer loop.
	if (
		presented.length !== expected.length ||
		!timingSafeEqual(presented, expected)
	) {
		return { ok: false, reason: "bad-signature" };
	}

	const result = eventSchema.safeParse(parsed);
	if (!result.success) return { ok: false, reason: "malformed" };

	return { ok: true, event: result.data };
}
