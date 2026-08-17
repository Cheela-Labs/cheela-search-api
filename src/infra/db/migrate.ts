import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

/**
 * A forward-only migration runner.
 *
 * Small enough to read in one sitting, which is the point — a migration
 * runner is the code most likely to be inspected during an incident and least
 * likely to be understood if it is a dependency.
 *
 * The ordering property that matters: the advisory lock is taken *before* the
 * ledger table is created, not after. Two containers starting at once on an
 * empty database will otherwise both run `CREATE TABLE schema_migrations`, and
 * one of them loses with a duplicate-key error at the exact moment a deploy is
 * least able to explain itself.
 */

/** An arbitrary constant that only this application uses. */
const LOCK_ID = 0x5ea4_c8a2;

export type MigrationResult = {
	applied: string[];
	alreadyApplied: string[];
};

export function migrationsDirectory(fromFileUrl: string): string {
	// Resolved relative to the compiled file so it works from src/ under tsx
	// and from dist/ in the container, where `migrations/` sits beside it.
	return join(dirname(fileURLToPath(fromFileUrl)), "..", "migrations");
}

export async function migrate(
	pool: pg.Pool,
	directory: string,
): Promise<MigrationResult> {
	const files = (await readdir(directory))
		.filter((name) => name.endsWith(".sql"))
		// Lexicographic, which is why they are numbered with leading zeros.
		.sort();

	const client = await pool.connect();
	const result: MigrationResult = { applied: [], alreadyApplied: [] };

	try {
		await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
		await client.query(`
			CREATE TABLE IF NOT EXISTS public.schema_migrations (
				name       text PRIMARY KEY,
				applied_at timestamptz NOT NULL DEFAULT now()
			)
		`);

		const { rows } = await client.query<{ name: string }>(
			"SELECT name FROM public.schema_migrations",
		);
		const done = new Set(rows.map((row) => row.name));

		for (const name of files) {
			if (done.has(name)) {
				result.alreadyApplied.push(name);
				continue;
			}

			const sql = await readFile(join(directory, name), "utf8");
			// One transaction per file: a migration either happened or did not.
			// A partially applied file is the state nobody can recover from
			// without reading the SQL and guessing how far it got.
			await client.query("BEGIN");
			try {
				await client.query(sql);
				await client.query(
					"INSERT INTO public.schema_migrations (name) VALUES ($1)",
					[name],
				);
				await client.query("COMMIT");
				result.applied.push(name);
			} catch (error) {
				await client.query("ROLLBACK");
				throw new Error(
					`migration ${name} failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
					{ cause: error },
				);
			}
		}
	} finally {
		await client
			.query("SELECT pg_advisory_unlock($1)", [LOCK_ID])
			.catch(() => {});
		client.release();
	}

	return result;
}
