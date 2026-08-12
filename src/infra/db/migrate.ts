import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

/**
 * The migration runner.
 *
 * Hand-rolled rather than a framework, because what a migration runner has to
 * get right is short and worth reading: apply each file once, in order, inside
 * a transaction, and never twice concurrently. Everything a framework adds on
 * top of that — down migrations, generated SQL, a DSL — is surface this service
 * does not want between it and its schema.
 *
 * ## Forward only
 *
 * There are no down migrations, deliberately. A down migration is written when
 * the schema is fresh in mind and run, if ever, months later against data it
 * was never tested with — the rollback that drops a column takes the data with
 * it. Recovering from a bad migration is a new forward migration, or a restore.
 *
 * ## The advisory lock is not optional
 *
 * Cloud Run scales from zero, so several instances can cold-start within the
 * same second. Without a lock they all read an empty `schema_migrations` and
 * all apply `0001`, and the losers fail on "relation already exists" — during a
 * deploy, which is the worst possible time to be reading an ambiguous error.
 * `pg_advisory_lock` is held on one connection for the duration and released
 * whatever happens.
 */

/** Arbitrary, fixed, and only ever used here. Two callers with the same key serialise. */
const LOCK_KEY = 0x5ea4_c8a1;

const LEDGER = `
	CREATE TABLE IF NOT EXISTS public.schema_migrations (
		name       text        PRIMARY KEY,
		applied_at timestamptz NOT NULL DEFAULT now()
	)
`;

export type MigrationResult = {
	applied: string[];
	alreadyApplied: string[];
};

/**
 * Resolves the migrations directory.
 *
 * One level up from this module in both layouts that exist — `src/infra/db` is
 * bundled to `dist/`, and both `src/..`-relative and `dist/..`-relative paths
 * land on the app root. The Dockerfile copies `migrations/` for the same
 * reason: they are data the runtime reads, not source the build inlines.
 */
export function migrationsDirectory(fromFileUrl: string): string {
	return path.join(
		path.dirname(new URL(fromFileUrl).pathname),
		"..",
		"migrations",
	);
}

export async function migrate(
	pool: Pool,
	directory: string,
): Promise<MigrationResult> {
	const files = (await readdir(directory))
		.filter((name) => name.endsWith(".sql"))
		// Lexicographic, which is why they are zero-padded. `10` sorting before
		// `9` is the classic way to apply a schema in the wrong order.
		.sort();

	const client = await pool.connect();
	const applied: string[] = [];
	const alreadyApplied: string[] = [];

	try {
		// The lock comes first, before *anything* touches the schema — including
		// creating the ledger. `CREATE TABLE IF NOT EXISTS` is not atomic against
		// concurrent creation: run four of them at once and Postgres raises
		// `duplicate key value violates unique constraint
		// "pg_type_typname_nsp_index"` from its own catalog, because the
		// existence check and the insert are not one operation. An advisory lock
		// needs no table of its own, which is what makes it the right thing to
		// reach for before the first DDL rather than after it.
		await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
		await client.query(LEDGER);

		// Read *after* taking the lock. Reading first would mean deciding what to
		// apply from a snapshot that another instance can invalidate while we
		// wait — which is the race the lock is here to remove.
		const { rows } = await client.query<{ name: string }>(
			"SELECT name FROM public.schema_migrations",
		);
		const done = new Set(rows.map((row) => row.name));

		for (const name of files) {
			if (done.has(name)) {
				alreadyApplied.push(name);
				continue;
			}

			const sql = await readFile(path.join(directory, name), "utf8");

			// One transaction per migration, so a failure leaves the schema at the
			// last complete step rather than halfway through this one. CREATE
			// INDEX CONCURRENTLY cannot run in a transaction — if one is ever
			// needed, it gets a file of its own and this comment gets an argument.
			await client.query("BEGIN");
			try {
				await client.query(sql);
				await client.query(
					"INSERT INTO public.schema_migrations (name) VALUES ($1)",
					[name],
				);
				await client.query("COMMIT");
			} catch (error) {
				await client.query("ROLLBACK");
				throw new Error(
					`migration ${name} failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
					{ cause: error },
				);
			}

			applied.push(name);
		}

		return { applied, alreadyApplied };
	} finally {
		// Released even on the failure path, or the next instance to start blocks
		// forever behind a lock nobody holds a reason for.
		await client
			.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY])
			.catch(() => {});
		client.release();
	}
}
