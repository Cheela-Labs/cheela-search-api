import { z } from "zod";

/**
 * Environment, parsed once and frozen.
 *
 * The rule this file follows: **nothing here is optional**. Every field either
 * comes from the environment or has a default, and no field can be
 * `undefined` at a call site. A variable made optional so the service can boot
 * without it is a variable that will be missing in production, discovered by a
 * user rather than by a deploy.
 *
 * Where a default exists it is because the default is *right*, not because the
 * variable was inconvenient to set. Credentials have no defaults.
 */

const csv = (fallback: string) =>
	z
		.string()
		.default(fallback)
		.transform((value) =>
			value
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean),
		);

const integer = (fallback: number, min = 1) =>
	z.coerce.number().int().min(min).default(fallback);

/**
 * Strict boolean env var, the same shape `apps/server/src/shared/config/env.ts`
 * uses and for the same reason: `z.coerce.boolean()` follows JS truthiness, so
 * the string `"false"` coerces to `true`. A security flag that turns itself on
 * when you try to turn it off is worse than no flag.
 */
const booleanEnv = (fallback: boolean) =>
	z
		.enum(["true", "false", "1", "0"])
		.default(fallback ? "true" : "false")
		.transform((value) => value === "true" || value === "1");

const schema = z.object({
	NODE_ENV: z
		.enum(["development", "test", "production"])
		.default("development"),
	PORT: integer(3006),
	LOG_LEVEL: z
		.enum(["fatal", "error", "warn", "info", "debug", "trace"])
		.default("info"),

	/** The surface, and localhost for development. */
	ALLOWED_ORIGINS: csv("http://localhost:3005,https://search.cheelalabs.com"),

	// ---- Storage ----------------------------------------------------------

	/**
	 * Metadata only. The index is Vespa's; this holds what a graph and a
	 * ledger need — entities, edges, manifests, the query log — and nothing
	 * that a search request reads on its critical path.
	 */
	DATABASE_URL: z.string().min(1),
	DATABASE_POOL_MAX: integer(5),
	DATABASE_STATEMENT_TIMEOUT_MS: integer(8000),

	/** Sessions, caches, rate limits, and the event streams. */
	REDIS_URL: z.string().min(1),

	VESPA_ENDPOINT: z.string().url(),
	/**
	 * Vespa is the fast path — the architecture's whole claim is sub-500ms
	 * when served from the index — so this is a budget, not a safety net. A
	 * query that blows it should fall through to external retrieval rather
	 * than spend the user's patience waiting.
	 */
	VESPA_TIMEOUT_MS: integer(400),

	GCS_RAW_BUCKET: z.string().min(1),

	// ---- External retrieval ------------------------------------------------

	TAVILY_API_KEY: z.string().min(1),
	ANYSEARCH_API_KEY: z.string().min(1),
	/** The TDS's soft timeout. A provider slower than this is not an error. */
	EXTERNAL_TIMEOUT_MS: integer(800),

	// ---- Models ------------------------------------------------------------

	MODEL_API_KEY: z.string().min(1),
	MODEL_ENDPOINT: z
		.string()
		.url()
		.default("https://openrouter.ai/api/v1/chat/completions"),
	/** Small and fast: this runs before retrieval, inside the budget. */
	INTENT_MODEL: z.string().default("google/gemini-2.5-flash-lite"),
	EVOLUTION_MODEL: z.string().default("google/gemini-2.5-flash-lite"),
	GENERATOR_MODEL: z.string().default("google/gemini-2.5-flash"),

	// ---- Egress policy -----------------------------------------------------
	//
	// The highest-severity configuration in this service. See infra/egress.

	EGRESS_TIMEOUT_MS: integer(10000),
	EGRESS_MAX_BYTES: integer(2_000_000),
	EGRESS_MAX_REDIRECTS: integer(3, 0),
	EGRESS_USER_AGENT: z
		.string()
		.default("CheelaSearchBot/1.0 (+https://search.cheelalabs.com/bot)"),
	/**
	 * Whether robots.txt is obeyed. Required by the TDS's security section and
	 * on by default; the switch exists so a test can turn it off, not so a
	 * deployment can.
	 */
	EGRESS_RESPECT_ROBOTS: booleanEnv(true),

	// ---- Gate --------------------------------------------------------------

	SEARCH_API_TOKEN: z.string().min(1),
	/**
	 * `observe` logs a rejection and admits the request anyway. It exists for
	 * the window between deploying the token here and setting it on the
	 * caller, and it is the wrong setting to leave on.
	 */
	SEARCH_API_TOKEN_MODE: z.enum(["observe", "enforce"]).default("enforce"),

	RATE_LIMIT_MAX: integer(60),
	RATE_LIMIT_WINDOW_MS: integer(60_000),

	/**
	 * HMAC key for internal events. The TDS asks for signed internal events;
	 * the consumer is the worker, and the thing being prevented is a stream
	 * entry that did not come from us being replayed into the indexer.
	 */
	EVENT_SIGNING_KEY: z.string().min(16),

	// ---- Sessions and caches ----------------------------------------------

	/** The TDS: "sessions expire after inactivity". Thirty minutes of it. */
	SESSION_TTL_SECONDS: integer(1800),
	/** TDS caching section: 10 minutes, because rankings move. */
	QUERY_CACHE_TTL_MS: integer(600_000),
	/** TDS: 24 hours. */
	DOCUMENT_CACHE_TTL_MS: integer(86_400_000),
	/** TDS: 1 hour. */
	ENTITY_CACHE_TTL_MS: integer(3_600_000),

	// ---- Retrieval and ranking --------------------------------------------

	/** Reciprocal Rank Fusion's constant. The TDS pins it at 60. */
	RRF_K: integer(60),
	/** How many hypotheses the evolution engine may produce, including the original. */
	MAX_HYPOTHESES: integer(4),
	/** The TDS's cross-encoder stage: top 30. */
	RERANK_COUNT: integer(30),
	/** Below this, stage A is not enough and external providers are called. */
	INDEX_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.62),

	// ---- Telemetry ---------------------------------------------------------

	GCP_PROJECT_ID: z.string().default(""),
	/** Tracing is off unless a project is named; there is nowhere to send it. */
	OTEL_ENABLED: booleanEnv(false),
});

export type Config = Readonly<z.infer<typeof schema>>;

function parse(): Config {
	const result = schema.safeParse(process.env);

	if (!result.success) {
		// Naming every offending variable at once. A boot that fails one
		// variable at a time costs one deploy per variable.
		const problems = result.error.issues
			.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("\n");
		throw new Error(
			`search-api cannot start: the environment is incomplete.\n${problems}`,
		);
	}

	return Object.freeze(result.data);
}

export const config: Config = parse();
