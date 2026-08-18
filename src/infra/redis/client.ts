import Redis, { type RedisOptions } from "ioredis";
import { config } from "../../shared/config.js";
import { logger } from "../../shared/logger.js";

/**
 * The Redis connection.
 *
 * `lazyConnect` matters more than it looks: without it, importing this module
 * opens a socket, so every unit test that imports anything downstream of it
 * starts trying to reach a Redis that is not there. With it, a test that never
 * issues a command never connects.
 *
 * `maxRetriesPerRequest: 1` is the other deliberate one. Redis holds sessions
 * and caches here — things whose absence degrades a search rather than failing
 * it — so a command that cannot be served should give up quickly and let the
 * caller carry on without it. The default behaviour queues commands forever
 * and turns a Redis outage into a request timeout.
 */
const options: RedisOptions = {
	lazyConnect: true,
	maxRetriesPerRequest: 1,
	enableOfflineQueue: false,
	connectTimeout: 2000,
	retryStrategy: (attempt) => Math.min(attempt * 200, 3000),
};

export const redis = new Redis(config.REDIS_URL, options);

redis.on("error", (error: Error) => {
	// At debug: a disconnected Redis emits this continuously, and at warn it
	// buries every other line in the log during an outage.
	logger.debug({ error: error.message }, "redis error");
});

/** A separate connection, because a blocking read occupies one entirely. */
export function createBlockingClient(): Redis {
	return new Redis(config.REDIS_URL, {
		...options,
		maxRetriesPerRequest: null,
	});
}

/**
 * Opens the connection, and waits.
 *
 * `lazyConnect` means no socket opens until something is sent, and
 * `enableOfflineQueue: false` means there is no queue to hold that first
 * command while it opens — so the first command is rejected outright with
 * "Stream isn't writeable and enableOfflineQueue options is false".
 *
 * Here that lands on `publish`, which swallows failures by design so a Redis
 * problem never costs a user their search. The cost is that the first event
 * after a cold start is dropped and only a warning says so — and on a service
 * that scales to zero, "after a cold start" is a meaningful share of all
 * traffic. In practice the startup probe's `redisReachable` ping usually
 * connects first, which is exactly the kind of accident that stops being true
 * when somebody changes the health check.
 */
export async function connectRedis(): Promise<void> {
	if (redis.status !== "wait") return;
	await redis.connect();
}

export async function redisReachable(): Promise<boolean> {
	try {
		const reply = await redis.ping();
		return reply === "PONG";
	} catch {
		return false;
	}
}
