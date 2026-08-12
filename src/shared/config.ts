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

		COMPOSER_API_KEY: z.string().min(1).optional(),

		/** Pinned, because "the current default" is not a reproducible answer. */
		COMPOSER_MODEL: z.string().min(1).default("openai/gpt-oss-20b:free"),

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
