import { serve } from "@hono/node-server";
import { createApp } from "./gateway/app.js";
import { config } from "./shared/config.js";
import { logger } from "./shared/logger.js";
import { startTelemetry, stopTelemetry } from "./shared/telemetry.js";
import { buildDeps } from "./wiring.js";

await startTelemetry();

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
