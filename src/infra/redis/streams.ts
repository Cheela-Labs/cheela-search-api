import { type CheelaEvent, createEventBus } from "@cheela/search-core";
import { config } from "../../shared/config.js";
import { logger } from "../../shared/logger.js";
import { redis as shared } from "./client.js";

/**
 * This service's half of the event bus: publishing, and nothing else.
 *
 * The implementation lives in `@cheela/search-core` because the other half —
 * the Console's learn worker (ADR-003) — has to agree with it about the
 * signature, the canonical JSON it covers, and the entry's field names. None of
 * those disagreements produce an error; they produce a bus that has gone quiet.
 *
 * The consuming half used to be here too, and is gone with `worker.ts`: this
 * service serves queries. No blocking client is constructed for the same
 * reason — a blocking read needs its own connection, and a publisher has no
 * blocking read to isolate.
 */

const bus = createEventBus({
	client: shared,
	signingKey: config.EVENT_SIGNING_KEY,
	onPublishError: ({ stream, type, error }) => {
		logger.warn(
			{ stream, type, error: error.message },
			"could not publish event",
		);
	},
});

export function publish(
	stream: string,
	event: CheelaEvent,
): Promise<string | null> {
	return bus.publish(stream, event);
}
