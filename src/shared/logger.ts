import pino from "pino";
import { config } from "./config.js";

/**
 * Structured JSON, as the TDS's observability section asks for.
 *
 * No prettifier in production: Cloud Logging parses JSON lines into
 * structured entries and a pretty-printed line is one unsearchable string.
 */
export const logger = pino({
	level: config.LOG_LEVEL,
	// Cloud Logging reads `severity`, not pino's numeric `level`.
	formatters: {
		level: (label) => ({ severity: label.toUpperCase(), level: label }),
	},
	base: { service: "search-api" },
	redact: {
		// These arrive in headers and config and must never reach a log line.
		paths: [
			"req.headers.authorization",
			"headers.authorization",
			"apiKey",
			"token",
		],
		censor: "[redacted]",
	},
});
