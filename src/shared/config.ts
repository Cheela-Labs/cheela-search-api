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
const schema = z.object({
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
});

export type Config = z.infer<typeof schema>;

export const config: Config = Object.freeze(schema.parse(process.env));
