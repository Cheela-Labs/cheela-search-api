import { serve } from "@hono/node-server";
import pino from "pino";
import { createApp } from "./app";
import { config } from "./shared/config";

const logger = pino({ level: config.LOG_LEVEL });

serve({ fetch: createApp().fetch, port: config.PORT }, (info) => {
	logger.info(
		{ port: info.port, env: config.NODE_ENV },
		"search-api listening",
	);
});
