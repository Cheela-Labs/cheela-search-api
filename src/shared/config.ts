import { z } from "zod";

/**
 * Parsed once, at import, and frozen — the same discipline as
 * `apps/server/src/shared/config/env.ts`. Reading `process.env` at the point
 * of use is how a service ends up with two different opinions about whether a
 * feature is on.
 *
 * Nothing here is required yet. That is a property of Phase 0 not having
 * started, not a decision: PLAN.md lists the variables each phase adds, and
 * each one arrives as a required field in this schema at the same time as the
 * code that reads it. A variable that is optional so the service can boot
 * without it is a variable that will be missing in production.
 */
const schema = z
	.object({
		NODE_ENV: z
			.enum(["development", "test", "production"])
			.default("development"),

		/** 3006 keeps out of the way of the five Next apps and apps/server. */
		PORT: z.coerce.number().int().positive().default(3006),

		LOG_LEVEL: z
			.enum(["fatal", "error", "warn", "info", "debug", "trace"])
			.default("info"),

		/**
		 * Origins allowed to read the event stream. The surface is on its own host,
		 * so this is a real cross-origin request and not a formality.
		 */
		ALLOWED_ORIGINS: z
			.string()
			.default("http://localhost:3005,https://search.cheelalabs.com")
			.transform((value) =>
				value
					.split(",")
					.map((origin) => origin.trim())
					.filter(Boolean),
			),

		/* ---------------------------------------------------------------------
	   Storage — step 2 of PLAN.md's build order.

	   DATABASE_URL is required, with no default, per the rule this file opens
	   with: a missing connection string is a wiring mistake, and the service
	   should refuse to start rather than discover it at the first query. Tests
	   supply one through vitest.config.ts because `config` is parsed and frozen
	   at import, before any test body runs.
	   ------------------------------------------------------------------- */

		DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

		/**
		 * Multiply by `--max-instances` before raising this: that product is what
		 * the database actually sees, and a scale-to-zero service asking for four
		 * times what its Postgres allows fails on its first spike rather than in
		 * a load test.
		 */
		DATABASE_POOL_MAX: z.coerce.number().int().positive().default(5),

		/** Bounded below the request deadline, so a query cannot outlive its caller. */
		DATABASE_STATEMENT_TIMEOUT_MS: z.coerce
			.number()
			.int()
			.positive()
			.default(8_000),

		/* ---------------------------------------------------------------------
	   Caching — step 7 of PLAN.md's build order.

	   Two TTLs, and the gap between them is the design. A page's content
	   mostly does not change; which pages a vendor names for a query moves
	   continuously. One TTL for both would either re-fetch stable pages for
	   nothing or serve a ranking from last week.
	   ------------------------------------------------------------------- */

		/**
		 * How long a fetched page is served without asking the network.
		 *
		 * Seven days, and it is not the whole story: an expired document is
		 * revalidated with `If-None-Match` rather than re-downloaded, so the
		 * common case past this deadline still costs no bandwidth and no
		 * extraction. The TTL decides when we *ask*, not when we discard.
		 */
		CONTENT_CACHE_TTL_MS: z.coerce
			.number()
			.int()
			.positive()
			.default(7 * 24 * 60 * 60 * 1_000),

		/**
		 * How long an upstream provider's URL list is reused. PLAN.md: "Rankings
		 * move."
		 *
		 * Ten minutes. Long enough that a query repeated during one session — or
		 * by the surface retrying — costs one vendor call, short enough that a
		 * provider going bad becomes visible in minutes rather than staying
		 * masked until the cache drains.
		 */
		QUERY_CACHE_TTL_MS: z.coerce
			.number()
			.int()
			.positive()
			.default(10 * 60 * 1_000),

		/* ---------------------------------------------------------------------
	   Upstream search — step 3 of PLAN.md's build order.

	   Each credential is optional on its own; the refinement below requires at
	   least one *complete* provider. That is the invariant worth enforcing —
	   "this service has somewhere to search" — and it is stricter than making
	   every key required, which would force a deploy to hold two vendors'
	   credentials to run with one.
	   ------------------------------------------------------------------- */

		TAVILY_API_KEY: z.string().min(1).optional(),

		ANYSEARCH_API_KEY: z.string().min(1).optional(),

		GOOGLE_CSE_API_KEY: z.string().min(1).optional(),
		/** The Programmable Search Engine id (`cx`), configured to search the whole web. */
		GOOGLE_CSE_ENGINE_ID: z.string().min(1).optional(),

		/**
		 * Failover order, first to last. A name whose credentials are absent is
		 * skipped rather than being an error, so the order can name every provider
		 * the service might ever have and the deploy decides which exist.
		 */
		SEARCH_PROVIDER_ORDER: z
			.string()
			.default("tavily,anysearch")
			.transform((value) =>
				value
					.split(",")
					.map((name) => name.trim())
					.filter(Boolean),
			),

		/**
		 * What to do with the paid vendors: try them in order, or ask them all.
		 *
		 * **This is a bill, not a tuning knob.** PLAN.md's cost model says
		 * upstream API calls are the dominant cost per query, so `fanout`
		 * multiplies the largest line item by the number of configured vendors on
		 * every query — including all the ones the first vendor would have
		 * answered perfectly well.
		 *
		 * What it buys is a wider *candidate set*, which is a real gain and a
		 * different one from better ordering: two vendors disagree about which
		 * ten pages exist far more than they disagree about their order, and a
		 * page that is never fetched cannot be reranked into an answer.
		 *
		 * Defaults to `rotate` because the default must not be the expensive one.
		 * Traffic being low is a reason to *choose* fan-out deliberately, not a
		 * reason to ship it as the thing that happens when nobody decides.
		 */
		SEARCH_PROVIDER_MODE: z.enum(["rotate", "fanout"]).default("rotate"),

		/**
		 * Free specialist retrievers, asked in parallel alongside the paid ones.
		 *
		 * Unlike `SEARCH_PROVIDER_ORDER` these cost nothing, so they are on by
		 * default: the reason to omit a retriever is normally its bill, and there
		 * is not one. A name whose credentials are missing is skipped, so listing
		 * `github` without a token is not an error.
		 */
		SEARCH_SUPPLEMENTS: z
			.string()
			.default("wikipedia,github")
			.transform((value) =>
				value
					.split(",")
					.map((name) => name.trim())
					.filter(Boolean),
			),

		/**
		 * Lifts GitHub search from 10 requests per minute to 30.
		 *
		 * Required for the provider to be built at all, and that is deliberate:
		 * unauthenticated, one Cloud Run instance would exhaust the quota in about
		 * six seconds of ordinary traffic and then contribute nothing but
		 * `rate-limited` entries to the retrieval statistics — which is worse than
		 * being absent, because it makes an extraction metric look like an
		 * extraction problem.
		 *
		 * Needs no scopes. A fine-grained token with zero permissions raises the
		 * rate limit, which is the only thing we want from it.
		 */
		GITHUB_TOKEN: z.string().min(1).optional(),

		/* ---------------------------------------------------------------------
	   Composition — step 6 of PLAN.md's build order.

	   Optional, unlike the search providers: with no model the service composes
	   by quoting the best passages verbatim. That is a worse answer and an
	   honest one, and it beats refusing a query whose retrieval succeeded.
	   ------------------------------------------------------------------- */

		/**
		 * Shared secret the surface must present on `/search`.
		 *
		 * Optional, and that is a sequencing decision rather than a soft stance:
		 * enabling it here before the proxy has the matching value would 401 every
		 * real request. Set it on the caller first, then here. Unset, the endpoint
		 * is open — which is the state it shipped in, and the reason this exists.
		 */
		SEARCH_API_TOKEN: z.string().min(1).optional(),

		/**
		 * What the gate does with a token that does not match.
		 *
		 * `observe` admits the request and logs the verdict; `enforce` refuses it.
		 * The two states exist because turning auth on is the one change that
		 * cannot be verified before it is made — the caller either holds the
		 * secret or does not, and there is no way to ask from outside. Deploying
		 * `observe` first turns that into a log line instead of an outage, which
		 * is how this should have been done the first time.
		 */
		SEARCH_API_TOKEN_MODE: z.enum(["observe", "enforce"]).default("enforce"),

		COMPOSER_API_KEY: z.string().min(1).optional(),

		/** Pinned, because "the current default" is not a reproducible answer. */
		COMPOSER_MODEL: z.string().min(1).default("google/gemini-2.5-flash"),

		/**
		 * Deliberately cheaper than the composer's. Routing chooses one of three
		 * words and runs on every query; composition writes the answer and runs
		 * once. Shares COMPOSER_API_KEY — one vendor account, two model pins.
		 */
		ROUTER_MODEL: z.string().min(1).default("google/gemini-2.5-flash-lite"),

		/* ---------------------------------------------------------------------
	   Egress — step 1 of PLAN.md's build order.

	   These carry defaults, unlike the credentials and connection strings the
	   later steps add. The rule those follow — required, so the service cannot
	   boot without them — exists because a missing DATABASE_URL is a wiring
	   mistake that must fail loudly at start rather than at first use. A
	   timeout is not wiring: there is a correct-by-default value, an unset
	   variable means "the default is fine", and requiring one would make every
	   deployment restate four numbers nobody has an opinion about.
	   ------------------------------------------------------------------- */

		/** Whole-request deadline, redirects included. */
		EGRESS_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

		/** A page above this is dropped, not truncated — see the client's comment. */
		EGRESS_MAX_BYTES: z.coerce.number().int().positive().default(2_000_000),

		EGRESS_MAX_REDIRECTS: z.coerce.number().int().nonnegative().default(3),

		/**
		 * Identified, and pointing somewhere an operator can read about us. The
		 * architecture's rule that we crawl and invoke under a name that can be
		 * blocked starts here.
		 */
		EGRESS_USER_AGENT: z
			.string()
			.default("CheelaSearchBot/0.1 (+https://search.cheelalabs.com/bot)"),
	})
	/**
	 * At least one complete upstream provider, or the service does not start.
	 *
	 * A search service that boots without anywhere to search is the failure this
	 * catches: it passes every health check and answers every query with nothing,
	 * which reads as "the index is empty" rather than "the deploy is wrong".
	 * Google CSE needs both halves — a key without an engine id is not a
	 * provider, it is half of one.
	 */
	.superRefine((value, context) => {
		const complete =
			Boolean(value.TAVILY_API_KEY) ||
			Boolean(value.ANYSEARCH_API_KEY) ||
			Boolean(value.GOOGLE_CSE_API_KEY && value.GOOGLE_CSE_ENGINE_ID);

		if (!complete) {
			context.addIssue({
				code: "custom",
				path: ["TAVILY_API_KEY"],
				message:
					"no upstream search provider is configured — set TAVILY_API_KEY " +
					"or ANYSEARCH_API_KEY",
			});
		}
	});

export type Config = z.infer<typeof schema>;

/**
 * Parses, or fails with something a person can act on.
 *
 * `schema.parse` throws a ZodError whose message is a JSON dump of issue
 * objects, printed with a module-load stack trace behind it. The most common
 * failure this service will ever have is a missing environment variable on a
 * fresh deploy, and "ZodError: [ { code: 'invalid_type', ... } ]" is a worse
 * answer to that than one line naming the variable.
 */
function parseConfig(): Config {
	const result = schema.safeParse(process.env);
	if (result.success) return result.data;

	const problems = result.error.issues
		.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
		.join("\n");

	throw new Error(
		`Invalid environment for @cheela/search-api:\n${problems}\n\n` +
			"See .env.example for what each one is and where its value comes from.",
	);
}

export const config: Config = Object.freeze(parseConfig());
