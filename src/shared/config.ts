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
	 *
	 * This is **Vespa's** budget: it is what goes in the query's `timeout`
	 * field, where `ranking.softtimeout` turns it into "return what you have"
	 * rather than an error. The HTTP client waits longer, by
	 * `VESPA_TRANSPORT_MARGIN_MS` — see `infra/vespa/client.ts` for why the
	 * two cannot be the same number.
	 */
	VESPA_TIMEOUT_MS: integer(400),
	/**
	 * How much longer the client waits than Vespa does.
	 *
	 * Vespa's soft timeout starts when Vespa receives the query and stops when
	 * it has an answer; the client's starts earlier and stops later, because
	 * the request and the response have to cross the network in between. Give
	 * them the same number and the client's abort always fires first — Vespa's
	 * partial result is thrown away in flight, every index query is recorded as
	 * a failure, and the degradation is invisible because the abort looks like
	 * an unreachable Vespa rather than a budget that was never survivable.
	 *
	 * That was the deployed behaviour: `degraded: ["vespa"]` on every query,
	 * with `vespa document search failed: This operation was aborted` in the
	 * logs and a healthy Vespa on the other end.
	 */
	VESPA_TRANSPORT_MARGIN_MS: integer(600),
	/**
	 * The budget for the one index query per request that reranks.
	 *
	 * Stage A issues a query per hypothesis and exactly one of them — the query
	 * as the reader typed it — runs `hybrid-rerank`, which adds a cross-encoder
	 * and a second embedder call to tokenise the query. That is the most
	 * expensive thing in the retrieval budget by design, and it does not fit in
	 * a budget sized for a plain lookup.
	 *
	 * Measured after the transport margin landed: nine index queries across
	 * three requests produced exactly three failures — one per request,
	 * whether the request had four hypotheses or one. The plain `hybrid`
	 * queries all succeeded. The reranking one never did.
	 *
	 * ## `softtimeout` does not cover this, and believing it did cost weeks
	 *
	 * This comment used to say the budget was "generous on purpose", because
	 * `ranking.softtimeout` means Vespa returns what it has at the deadline
	 * rather than failing — so an oversized budget costs nothing and an
	 * undersized one costs only some ranking quality. That is true of the match
	 * and first-rank phases. It is **not** true of the global phase or of
	 * summary fetch. When the cross-encoder overran, Vespa did not return a
	 * worse ordering; it returned an error:
	 *
	 *     No time left to get summaries, query timeout was 1971 ms
	 *
	 * — and the retriever counted that as a failed index query. So the budget is
	 * not a quality dial with a safe upper bound. It is a hard cliff, and it has
	 * to be set above what the global phase actually takes.
	 *
	 * 3000ms is that number for `rerank-count: 8` on the current node: typically
	 * 1.7-1.9s, worst observed 2.75s across eight runs, including runs sharing
	 * the node with the three-hypothesis fan-out. Both halves move together —
	 * changing `rerank-count` in `web_document.sd` without changing this is how
	 * the cliff gets rediscovered.
	 *
	 * Not raised further, and deliberately not raised to fit `rerank-count: 30`.
	 * That would need seven seconds, and this budget sits on the *fast* path —
	 * the one the architecture returns from immediately when confidence is high.
	 * A seven-second fast path is not a fast path.
	 */
	VESPA_RERANK_TIMEOUT_MS: integer(3000),

	/**
	 * Whether to run the cross-encoder at all. Off, because it does nothing.
	 *
	 * `rerank_tokens` is declared in `web_document.sd` and is **absent from
	 * every document in the index** — 121 sampled through `/document/v1`, not
	 * one of them has it, while `chunk_embeddings` is present on all of them.
	 * The cross-encoder therefore scores every pair with an empty document
	 * side, and returns the same answer for all of them:
	 *
	 *     relevance = 0.10001073   colombia earthquake
	 *     relevance = 0.10001122   semiconductor export controls
	 *     relevance = 0.10001304   wildfire evacuation orders
	 *
	 * That is `0.9 × ~0.00001 + 0.1 × normalize_linear(firstPhase)` — the whole
	 * ordering coming from the 10% first-phase term. Confirmed directly: the
	 * top five documents come back in *identical* order with and without the
	 * profile. It reorders nothing.
	 *
	 * Left on, it does active harm rather than nothing. `confidenceBasis`
	 * prefers the reranked score because it is the calibrated one, so
	 * confidence would read 0.1 against a 0.62 threshold and every search would
	 * keep falling through to external providers — while the first-phase score
	 * for the same queries is 3.07 out of a documented full house of 3.0, which
	 * clears the threshold outright. So the index would stay unusable, for a
	 * new reason, at a cost of 1.5s per search on the path whose whole purpose
	 * is being the fast one.
	 *
	 * This is a flag rather than a deletion because everything else about the
	 * setup is right — the profile, the model, the tokenizer component, the
	 * budget. What is missing is the data. Populate `rerank_tokens`, re-feed,
	 * confirm the ordering actually changes and that a relevant document scores
	 * well above 0.1, and turn this on.
	 */
	VESPA_RERANK_ENABLED: booleanEnv(false),

	GCS_RAW_BUCKET: z.string().min(1),

	// ---- External retrieval ------------------------------------------------

	TAVILY_API_KEY: z.string().min(1),
	ANYSEARCH_API_KEY: z.string().min(1),
	/**
	 * The TDS's soft timeout. A provider slower than this is not an error.
	 *
	 * The TDS says 800ms and that number is not survivable: measured against
	 * both vendors, Tavily answers in 1.4–1.7s and AnySearch in 1.4–3.4s, so
	 * an 800ms budget aborts every external call every time. The service ran
	 * that way and answered `{results: [], answer: ""}` with
	 * `degraded: ["tavily","anysearch"]` to every query — a soft timeout below
	 * the floor of what it is timing is not a soft timeout, it is an off
	 * switch.
	 *
	 * 4s clears both vendors' typical response and trims only AnySearch's
	 * tail. It is a budget for a *paid* call we have already decided to make:
	 * abandoning it at 800ms spends the money and discards the answer.
	 */
	EXTERNAL_TIMEOUT_MS: integer(4000),

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
