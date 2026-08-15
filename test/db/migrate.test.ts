import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/infra/db/migrate";

/**
 * The acceptance criterion for step 2 of PLAN.md: migrations run clean forward
 * on an empty database, and the schema matches the tables the plan lists.
 *
 * Runs against a real Postgres with pgvector — there is no version of this
 * assertion worth making against a fake. `docker compose up -d postgres`
 * provides one; `TEST_DATABASE_URL` points at it:
 *
 *   TEST_DATABASE_URL=postgres://supertokens:supertokens@127.0.0.1:5432/cheela_search
 *
 * Without that variable the suite skips rather than failing, so a checkout with
 * no database still runs the rest of the tests. That is a real gap and it is
 * named in the commit: CI skips these until a service container is wired, so
 * the acceptance evidence is a local run.
 *
 * Every test starts from a genuinely empty database — the schemas and the
 * ledger are dropped in `beforeAll`. "Runs clean forward on an empty database"
 * is not provable against one that already has the schema.
 */

const url = process.env.TEST_DATABASE_URL;
const directory = new URL("../../migrations", import.meta.url).pathname;

const suite = url ? describe : describe.skip;

suite("migrations", () => {
	let pool: Pool;

	beforeAll(async () => {
		pool = new Pool({ connectionString: url, max: 2 });
		await pool.query("DROP SCHEMA IF EXISTS web CASCADE");
		await pool.query("DROP SCHEMA IF EXISTS capability CASCADE");
		await pool.query("DROP TABLE IF EXISTS public.schema_migrations");
	});

	afterAll(async () => {
		await pool?.end();
	});

	it("applies every migration once, then reports the schema as current", async () => {
		const first = await migrate(pool, directory);
		expect(first.applied.length).toBeGreaterThan(0);
		expect(first.alreadyApplied).toEqual([]);

		// The property that matters on a service that scales from zero: running
		// the migrator again is a no-op, not an error.
		const second = await migrate(pool, directory);
		expect(second.applied).toEqual([]);
		expect(second.alreadyApplied).toEqual(first.applied);
	});

	it("serialises concurrent runners rather than racing them", async () => {
		// Both planes. `capability` arrived with 0004 and this cleanup listed
		// only `web`, so the ledger was dropped while `capability.sites` survived
		// — and the next run failed on "relation already exists" while claiming
		// to start from an empty database.
		await pool.query("DROP SCHEMA IF EXISTS web CASCADE");
		await pool.query("DROP SCHEMA IF EXISTS capability CASCADE");
		await pool.query("DROP TABLE IF EXISTS public.schema_migrations");

		// Four cold starts inside the same second, which is exactly what Cloud
		// Run does after an idle period. Without the advisory lock, three of
		// these fail on "relation already exists" — during a deploy.
		const racers = new Pool({ connectionString: url, max: 4 });
		try {
			const results = await Promise.all([
				migrate(racers, directory),
				migrate(racers, directory),
				migrate(racers, directory),
				migrate(racers, directory),
			]);

			// Exactly one runner did the work; the rest found it done.
			const didWork = results.filter((r) => r.applied.length > 0);
			expect(didWork).toHaveLength(1);
		} finally {
			await racers.end();
		}
	});

	it("creates the web plane the plan specifies", async () => {
		const { rows } = await pool.query<{ table_name: string }>(
			"SELECT table_name FROM information_schema.tables WHERE table_schema = 'web' ORDER BY table_name",
		);
		expect(rows.map((row) => row.table_name)).toEqual([
			"documents",
			"passages",
			"query_cache",
			"query_log",
		]);
	});

	it("stores embeddings as vectors, not as arrays of float", async () => {
		const { rows } = await pool.query<{ udt_name: string }>(
			`SELECT udt_name FROM information_schema.columns
			 WHERE table_schema = 'web' AND table_name = 'passages' AND column_name = 'embedding'`,
		);
		expect(rows[0]?.udt_name).toBe("vector");
	});

	it("indexes embeddings with HNSW over cosine distance", async () => {
		const { rows } = await pool.query<{ indexdef: string }>(
			"SELECT indexdef FROM pg_indexes WHERE schemaname = 'web' AND indexname = 'passages_embedding_idx'",
		);
		expect(rows[0]?.indexdef).toContain("hnsw");
		expect(rows[0]?.indexdef).toContain("vector_cosine_ops");
	});

	it("refuses an embedding with no model version", async () => {
		const document = await pool.query<{ id: string }>(
			`INSERT INTO web.documents (url, canonical_url, domain, content_hash, http_status)
			 VALUES ('https://x.test/a', 'https://x.test/a', 'x.test', 'h1', 200) RETURNING id`,
		);
		const documentId = document.rows[0]?.id;

		await expect(
			pool.query(
				`INSERT INTO web.passages (document_id, ordinal, text, content_hash, embedding)
				 VALUES ($1, 0, 'text', 'h2', $2)`,
				[documentId, `[${Array(1024).fill(0).join(",")}]`],
			),
		).rejects.toThrow(/passages_embedding_has_provenance/);
	});

	it("keeps one document per canonical URL", async () => {
		await pool.query(
			`INSERT INTO web.documents (url, canonical_url, domain, content_hash, http_status)
			 VALUES ('https://y.test/b?utm=1', 'https://y.test/b', 'y.test', 'h3', 200)`,
		);
		await expect(
			pool.query(
				`INSERT INTO web.documents (url, canonical_url, domain, content_hash, http_status)
				 VALUES ('https://y.test/b#frag', 'https://y.test/b', 'y.test', 'h4', 200)`,
			),
		).rejects.toThrow(/documents_canonical_url_key/);
	});

	it("caches the same query separately per provider", async () => {
		const insert = (provider: string) =>
			pool.query(
				`INSERT INTO web.query_cache (query_hash, normalized_query, provider, result_urls, expires_at)
				 VALUES ('qh1', 'a query', $1, ARRAY['https://z.test/'], now() + interval '1 hour')`,
				[provider],
			);

		await insert("alpha");
		// Same query, second vendor — must not collide, or the cache serves
		// whichever provider happened to be asked first.
		await expect(insert("beta")).resolves.toBeDefined();
		await expect(insert("alpha")).rejects.toThrow();
	});

	it("has nowhere to put a user identity in the query log", async () => {
		const { rows } = await pool.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_schema = 'web' AND table_name = 'query_log'`,
		);
		const columns = rows.map((row) => row.column_name);

		// By construction rather than by convention: a value that cannot be
		// stored cannot be stored by accident.
		expect(columns).toEqual(
			expect.arrayContaining([
				"normalized_query",
				"occurred_at",
				"result_domains",
			]),
		);
		for (const forbidden of [
			"user_id",
			"session_id",
			"ip",
			"ip_address",
			"client_ip",
		]) {
			expect(columns).not.toContain(forbidden);
		}
	});

	it("indexes result domains for containment, which a btree cannot serve", async () => {
		const { rows } = await pool.query<{ indexdef: string }>(
			"SELECT indexdef FROM pg_indexes WHERE schemaname = 'web' AND indexname = 'query_log_result_domains_idx'",
		);
		expect(rows[0]?.indexdef).toContain("gin");
	});
});
