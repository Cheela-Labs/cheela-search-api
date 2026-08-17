import pg from "pg";
import { migrate, migrationsDirectory } from "./infra/db/migrate.js";

/**
 * The migration entrypoint. Runs as a Cloud Run Job before a revision serves,
 * so a failed migration blocks the deploy rather than half-breaking it.
 *
 * It deliberately does **not** import `shared/config.js`. A migration needs a
 * database URL and nothing else, and requiring the full environment would mean
 * a schema change could not be applied without a Vespa endpoint, a Redis, two
 * search vendors and a model key — none of which it touches.
 */
async function main(): Promise<void> {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) {
		console.error("DATABASE_URL is required");
		process.exit(1);
	}

	const pool = new pg.Pool({ connectionString, max: 1 });
	try {
		const result = await migrate(pool, migrationsDirectory(import.meta.url));
		for (const name of result.applied) console.log(`applied  ${name}`);
		for (const name of result.alreadyApplied) console.log(`current  ${name}`);
		console.log(
			`${result.applied.length} applied, ${result.alreadyApplied.length} already current`,
		);
	} finally {
		await pool.end();
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
