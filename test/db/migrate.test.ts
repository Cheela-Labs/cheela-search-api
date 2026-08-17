import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/infra/db/migrate.js";

/**
 * The migration suite, against a real Postgres or not at all.
 *
 * "Migrations apply clean forward on an empty database" is not a claim worth
 * making against a fake. It reads TEST_DATABASE_URL rather than DATABASE_URL
 * deliberately: this suite drops and recreates schemas, and pointing it at the
 * variable a service uses is how a real database gets wiped by a test run.
 */
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

/**
 * The real migrations directory.
 *
 * Not `migrationsDirectory()`: that resolves one level up from its caller,
 * because its caller is `src/migrate.ts` and the same relative path has to work
 * from `dist/` in the container. Calling it from here would look for
 * `src/infra/migrations`. The function is exercised by the entrypoint; what this
 * suite needs is the files.
 */
const directory = fileURLToPath(new URL("../../migrations", import.meta.url));

/** Each test gets its own database, so they cannot see each other's schema. */
async function withDatabase<T>(
	name: string,
	work: (pool: pg.Pool) => Promise<T>,
): Promise<T> {
	const admin = new pg.Pool({ connectionString: url, max: 1 });
	try {
		await admin.query(`DROP DATABASE IF EXISTS ${name}`);
		await admin.query(`CREATE DATABASE ${name}`);
	} finally {
		await admin.end();
	}

	const target = new URL(url as string);
	target.pathname = `/${name}`;
	const pool = new pg.Pool({ connectionString: target.toString(), max: 2 });

	try {
		return await work(pool);
	} finally {
		await pool.end();
		const cleanup = new pg.Pool({ connectionString: url, max: 1 });
		await cleanup.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
		await cleanup.end();
	}
}

const columnsOf = async (pool: pg.Pool, schema: string, table: string) => {
	const { rows } = await pool.query<{ column_name: string }>(
		`SELECT column_name FROM information_schema.columns
		  WHERE table_schema = $1 AND table_name = $2`,
		[schema, table],
	);
	return new Set(rows.map((row) => row.column_name));
};

suite("migrations", () => {
	it("apply forward on an empty database", async () => {
		await withDatabase("cheela_mig_empty", async (pool) => {
			const result = await migrate(pool, directory);
			expect(result.applied.length).toBeGreaterThan(0);
			expect(result.alreadyApplied).toEqual([]);

			const { rows } = await pool.query<{ count: string }>(
				`SELECT count(*)::text AS count FROM information_schema.tables
				  WHERE table_schema IN ('search','graph','capability','crawl')`,
			);
			expect(Number(rows[0].count)).toBeGreaterThanOrEqual(9);
		});
	}, 60_000);

	it("are idempotent", async () => {
		await withDatabase("cheela_mig_twice", async (pool) => {
			const first = await migrate(pool, directory);
			const second = await migrate(pool, directory);

			expect(second.applied).toEqual([]);
			expect(second.alreadyApplied).toEqual(first.applied);
		});
	}, 60_000);

	it("survive four runners racing a cold start", async () => {
		// The real scenario: several containers of a new revision start at once
		// against a database with no ledger table. Without the advisory lock being
		// taken *before* the ledger DDL, they all run CREATE TABLE
		// schema_migrations and the losers fail with a duplicate key at the exact
		// moment a deploy is least able to explain itself.
		await withDatabase("cheela_mig_race", async (pool) => {
			const racers = await Promise.all(
				Array.from({ length: 4 }, () => migrate(pool, directory)),
			);

			// Exactly one runner applies each migration; the rest see it as current.
			const applied = racers.flatMap((result) => result.applied);
			expect(new Set(applied).size).toBe(applied.length);
			expect(applied.length).toBeGreaterThan(0);
		});
	}, 120_000);

	it("replace the previous application's capability tables", async () => {
		// The bug the teardown at the top of 0001 exists for, and the reason it is
		// a migration rather than a runbook step. The creates use IF NOT EXISTS, which
		// protects against a table already being *there* and never against it
		// being *wrong* — so on a database the old app had migrated, the old shape
		// survived and the migration reported success. Nothing failed until the
		// first insert, in production.
		await withDatabase("cheela_mig_legacy", async (pool) => {
			await pool.query("CREATE SCHEMA capability");
			await pool.query("CREATE SCHEMA web");
			// The previous app's real shape, copied from its own migration 0004 —
			// including next_probe_at, which it had. A fixture that omitted it
			// found a second and louder failure: CREATE INDEX on the old table
			// aborts the whole migration. Both paths are covered because the
			// teardown now runs before any create.
			await pool.query(`
				CREATE TABLE capability.sites (
					domain text PRIMARY KEY,
					discovery_method text NOT NULL DEFAULT 'traffic',
					adp_state text NOT NULL DEFAULT 'unknown',
					first_seen_at timestamptz NOT NULL DEFAULT now(),
					last_probed_at timestamptz,
					next_probe_at timestamptz NOT NULL DEFAULT now()
				)`);
			await pool.query(`
				CREATE TABLE capability.manifests (
					id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
					domain text NOT NULL REFERENCES capability.sites (domain)
				)`);
			await pool.query(`
				CREATE TABLE capability.capabilities (
					id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
					manifest_id bigint NOT NULL REFERENCES capability.manifests (id),
					domain text NOT NULL,
					name text NOT NULL,
					invocable_by_us boolean NOT NULL DEFAULT false
				)`);
			await pool.query("CREATE TABLE web.documents (id bigint)");

			await migrate(pool, directory);

			const capabilities = await columnsOf(pool, "capability", "capabilities");
			// The new shape, not the old one.
			expect(capabilities.has("cap_id")).toBe(true);
			expect(capabilities.has("title")).toBe(true);
			expect(capabilities.has("provider")).toBe(true);
			expect(capabilities.has("callable")).toBe(true);
			expect(capabilities.has("manifest_id")).toBe(false);
			expect(capabilities.has("invocable_by_us")).toBe(false);

			const sites = await columnsOf(pool, "capability", "sites");
			expect(sites.has("state")).toBe(true);
			expect(sites.has("adp_state")).toBe(false);

			// The web plane is Vespa's now; its tables should be gone entirely.
			const { rows } = await pool.query<{ count: string }>(
				`SELECT count(*)::text AS count FROM information_schema.tables
				  WHERE table_schema = 'web'`,
			);
			expect(Number(rows[0].count)).toBe(0);
		});
	}, 60_000);

	it("leave a fresh database's tables alone", async () => {
		// The other half: on a database that never saw the old app, the teardown
		// must fall through and leave what 0001 creates alone.
		await withDatabase("cheela_mig_fresh", async (pool) => {
			await migrate(pool, directory);

			const capabilities = await columnsOf(pool, "capability", "capabilities");
			expect(capabilities.has("cap_id")).toBe(true);
			expect(capabilities.has("popularity")).toBe(true);

			// And the tables are usable, not merely present.
			await pool.query(
				"INSERT INTO capability.sites (domain) VALUES ('example.com')",
			);
			await pool.query(
				`INSERT INTO capability.capabilities
				   (cap_id, domain, invocation_name, title)
				 VALUES ('a.b', 'example.com', 'a.b', 'A thing')`,
			);
			const { rows } = await pool.query<{ cap_id: string }>(
				"SELECT cap_id FROM capability.capabilities",
			);
			expect(rows[0].cap_id).toBe("a.b");
		});
	}, 60_000);

	it("record every applied file in the ledger", async () => {
		await withDatabase("cheela_mig_ledger", async (pool) => {
			const result = await migrate(pool, directory);
			const { rows } = await pool.query<{ name: string }>(
				"SELECT name FROM public.schema_migrations ORDER BY name",
			);
			expect(rows.map((row) => row.name)).toEqual([...result.applied].sort());
		});
	}, 60_000);
});
