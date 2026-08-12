import { serve } from "@hono/node-server";
import pino from "pino";
import { createApp } from "./app";
import { config } from "./shared/config";

const logger = pino({ level: config.LOG_LEVEL });

serve(
	{
		fetch: createApp().fetch,
		port: config.PORT,
		// Explicit because Cloud Run routes to the container's external
		// interface. A server bound to loopback passes every local test and then
		// fails its startup probe with nothing in the log to say why.
		hostname: "0.0.0.0",
	},
	(info) => {
		logger.info(
			{ port: info.port, env: config.NODE_ENV },
			"search-api listening",
		);
	},
);
