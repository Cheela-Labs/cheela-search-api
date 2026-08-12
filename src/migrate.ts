import { Pool } from "pg";
import pino from "pino";
import { migrate, migrationsDirectory } from "./infra/db/migrate";
import { config } from "./shared/config";

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
 */

const logger = pino({ level: config.LOG_LEVEL });

async function main(): Promise<void> {
	// Its own pool, with one connection: this process does one thing and then
	// exits, and the server's pool sizing is about concurrent requests it does
	// not have.
	const pool = new Pool({ connectionString: config.DATABASE_URL, max: 1 });

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
