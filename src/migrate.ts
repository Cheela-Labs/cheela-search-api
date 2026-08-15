import { Pool } from "pg";
import pino from "pino";
import { migrate, migrationsDirectory } from "./infra/db/migrate";

/**
 * The migration entrypoint — `pnpm db:migrate`, or `node dist/migrate.js`.
 *
 * A separate process from the server, on purpose. Migrating on boot means every
 * cold start of a scale-to-zero service takes the advisory lock and reads the
 * ledger before it can serve anything, which turns a schema change into a
 * latency change. It also means a bad migration takes the service down rather
 * than failing a deploy step that can be read and retried.
 *
 * Run it as a Cloud Run Job, or as a Cloud Build step ahead of the deploy.
 *
 * ## It reads its two variables directly, and does not import `config`
 *
 * It used to, and the first Cloud Build that ran it failed like this:
 *
 *     Invalid environment for @cheela/search-api:
 *       TAVILY_API_KEY: no upstream search provider is configured
 *
 * — while applying a schema change. `shared/config` validates the *service's*
 * environment, including the refinement that at least one upstream vendor is
 * fully configured, so importing it made a migration refuse to run without a
 * search credential it has no use for.
 *
 * The alternative was handing the migrate job every runtime secret, which is
 * the wrong direction twice over: it widens what a schema change can reach, and
 * it means adding any required variable to the service silently breaks
 * migrations until somebody updates the job too. A migration needs a database
 * URL. This asks for exactly that.
 */

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	logger.error(
		"DATABASE_URL is required to run migrations, and nothing else is",
	);
	process.exit(1);
}

async function main(): Promise<void> {
	// Its own pool, with one connection: this process does one thing and then
	// exits, and the server's pool sizing is about concurrent requests it does
	// not have.
	const pool = new Pool({ connectionString: databaseUrl, max: 1 });

	try {
		const result = await migrate(pool, migrationsDirectory(import.meta.url));

		if (result.applied.length === 0) {
			logger.info(
				{ alreadyApplied: result.alreadyApplied.length },
				"schema is up to date",
			);
		} else {
			logger.info({ applied: result.applied }, "migrations applied");
		}
	} finally {
		await pool.end();
	}
}

main().catch((error: unknown) => {
	logger.error(
		{ error: error instanceof Error ? error.message : String(error) },
		"migration failed",
	);
	// Non-zero, so a Cloud Build step or Cloud Run Job fails loudly rather than
	// deploying a service against a schema that is not there.
	process.exit(1);
});
