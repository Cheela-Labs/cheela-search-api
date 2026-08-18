import { serve } from "@hono/node-server";
import { createApp } from "./gateway/app.js";
import { connectRedis } from "./infra/redis/client.js";
import { config } from "./shared/config.js";
import { logger } from "./shared/logger.js";
import { startTelemetry, stopTelemetry } from "./shared/telemetry.js";
import { buildDeps } from "./wiring.js";

await startTelemetry();

// Before the first request, so the first published event is not the one that
// discovers Redis is not connected yet. Non-fatal: this service degrades
// without Redis rather than refusing to start.
await connectRedis().catch((error: Error) => {
	logger.warn({ error: error.message }, "redis did not connect at startup");
});

const app = createApp(buildDeps());

const server = serve(
	{
		fetch: app.fetch,
		port: config.PORT,
		// Explicit, because Cloud Run's probes reach the container on its own
		// address and a server bound to localhost answers none of them.
		hostname: "0.0.0.0",
	},
	(info) => {
		logger.info(
			{ port: info.port, env: config.NODE_ENV },
			"search-api listening",
		);
	},
);

async function shutdown(signal: string): Promise<void> {
	logger.info({ signal }, "shutting down");
	server.close();
	await stopTelemetry();
	process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
