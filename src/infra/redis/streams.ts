import type { Redis } from "ioredis";
import {
	type CheelaEvent,
	sign,
	type VerifyResult,
	verify,
} from "../../contracts/events.js";
import { config } from "../../shared/config.js";
import { logger } from "../../shared/logger.js";
import { redis as shared } from "./client.js";

/**
 * Redis Streams: the event bus the TDS specifies.
 *
 * Streams rather than pub/sub because the consumer is a separate Cloud Run
 * service that can be restarting, deploying, or scaled to zero for a moment.
 * Pub/sub delivers to whoever is listening *now* and drops the rest, which for
 * an indexing pipeline means silently losing documents. A stream keeps them,
 * and a consumer group makes redelivery after a crash the default rather than
 * something to build.
 *
 * Every entry is HMAC-signed. See contracts/events.ts for why that is not
 * paranoia: the consumer of these events fetches URLs and feeds an index.
 */

/** Bounded so a stalled consumer cannot fill the instance. */
const MAX_STREAM_LENGTH = 100_000;

export async function publish(
	stream: string,
	event: CheelaEvent,
	client: Redis = shared,
): Promise<string | null> {
	try {
		return await client.xadd(
			stream,
			"MAXLEN",
			"~",
			MAX_STREAM_LENGTH,
			"*",
			"body",
			JSON.stringify(event),
			"signature",
			sign(event, config.EVENT_SIGNING_KEY),
		);
	} catch (error) {
		// Publishing is always fire-and-forget from the request path. Losing an
		// event costs a document that is not indexed until the next time it is
		// seen; throwing here would cost the user their search.
		logger.warn(
			{ stream, type: event.type, error: (error as Error).message },
			"could not publish event",
		);
		return null;
	}
}

export type Delivery = {
	id: string;
	stream: string;
	result: VerifyResult;
};

export async function ensureGroup(
	stream: string,
	group: string,
	client: Redis = shared,
): Promise<void> {
	try {
		// MKSTREAM so the group can be created before anything has published.
		await client.xgroup("CREATE", stream, group, "0", "MKSTREAM");
	} catch (error) {
		// BUSYGROUP simply means somebody else created it first, which is the
		// normal case with more than one replica.
		if (!String((error as Error).message).includes("BUSYGROUP")) throw error;
	}
}

/**
 * Reads one batch for a consumer group, blocking until something arrives or
 * the timeout expires.
 *
 * Entries that fail verification are returned rather than dropped, so the
 * caller can count them and acknowledge them — an unsigned entry that is never
 * acknowledged is redelivered forever and blocks the group's pending list.
 */
export async function consume(
	stream: string,
	group: string,
	consumer: string,
	client: Redis,
	options: { count?: number; blockMs?: number } = {},
): Promise<Delivery[]> {
	const response = (await client.xreadgroup(
		"GROUP",
		group,
		consumer,
		"COUNT",
		options.count ?? 16,
		"BLOCK",
		options.blockMs ?? 5000,
		"STREAMS",
		stream,
		">",
	)) as [string, [string, string[]][]][] | null;

	if (!response) return [];

	const deliveries: Delivery[] = [];
	for (const [streamName, entries] of response) {
		for (const [id, fields] of entries) {
			const record: Record<string, string> = {};
			for (let index = 0; index < fields.length; index += 2) {
				record[fields[index]] = fields[index + 1];
			}
			deliveries.push({
				id,
				stream: streamName,
				result: verify(
					record.body ?? "",
					record.signature,
					config.EVENT_SIGNING_KEY,
				),
			});
		}
	}
	return deliveries;
}

export async function acknowledge(
	stream: string,
	group: string,
	ids: string[],
	client: Redis,
): Promise<void> {
	if (ids.length === 0) return;
	await client.xack(stream, group, ...ids);
}

/** How far behind the consumer is. Reported on /health; the TDS wants index growth visible. */
export async function pending(
	stream: string,
	group: string,
	client: Redis = shared,
): Promise<number> {
	try {
		const summary = (await client.xpending(stream, group)) as [
			number,
			string,
			string,
			unknown,
		];
		return Number(summary?.[0] ?? 0);
	} catch {
		return 0;
	}
}
