import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresDocumentStore } from "../../src/infra/db/document-store";
import { migrate } from "../../src/infra/db/migrate";
import { PostgresQueryCache } from "../../src/infra/db/query-cache";
import { PostgresQueryLog } from "../../src/infra/db/query-log";

/**
 * The three stores of step 7, against a real Postgres.
 *
 * These assertions are about SQL, and SQL is exactly what a fake cannot check:
 * an upsert that conflicts on the wrong column, an expiry compared in the wrong
 * clock, an array written in an order the reader does not expect. All three
 * would pass against a stub and fail against a database.
 *
 *   TEST_DATABASE_URL=postgres://supertokens:supertokens@127.0.0.1:5432/cheela_search
 *
 * Skipped rather than failed without one, matching `test/db/migrate.test.ts`.
 *
 * **Runs in a database of its own**, created here and dropped afterwards.
 * `migrate.test.ts` drops and recreates the `web` schema to prove migrations
 * run clean on an empty database, and vitest runs files in parallel — sharing
 * one database means whichever file drops the schema second deletes the other's
 * tables mid-assertion. The failure looks like a migration bug and is a test
 * isolation bug, which is a bad hour to spend.
 */

const url = process.env.TEST_DATABASE_URL;
const directory = new URL("../../migrations", import.meta.url).pathname;
const suite = url ? describe : describe.skip;

const EXTRACTION = {
	title: "A Page",
	canonicalUrl: "https://example.com/a",
	image: "https://example.com/card.png",
	text: "Body text long enough to be worth caching.",
	publishedAt: null,
	contentHash: "hash-1",
};

const DATABASE = "cheela_search_stores_test";

suite("step 7 stores", () => {
	let admin: Pool;
	let pool: Pool;

	beforeAll(async () => {
		admin = new Pool({ connectionString: url });
		// `CREATE DATABASE` cannot run inside a transaction and cannot be
		// parameterised, hence the interpolation of a constant defined above.
		await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
		await admin.query(`CREATE DATABASE ${DATABASE}`);

		const target = new URL(url as string);
		target.pathname = `/${DATABASE}`;
		pool = new Pool({ connectionString: target.toString() });
		await migrate(pool, directory);
	});

	afterAll(async () => {
		await pool.end();
		await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
		await admin.end();
	});

	beforeEach(async () => {
		await pool.query(
			"TRUNCATE web.documents, web.query_cache, web.query_log CASCADE",
		);
	});

	describe("content cache", () => {
		it("round-trips a page, image and all", async () => {
			const store = new PostgresDocumentStore(pool);
			await store.put({
				requestedUrl: "https://example.com/a?utm_source=x",
				finalUrl: "https://example.com/a",
				domain: "example.com",
				status: 200,
				extraction: EXTRACTION,
				etag: '"v1"',
			});

			const found = await store.get("https://example.com/a");
			expect(found?.extraction.image).toBe("https://example.com/card.png");
			expect(found?.extraction.text).toBe(EXTRACTION.text);
			expect(found?.etag).toBe('"v1"');
			expect(found?.fresh).toBe(true);
		});

		/** The requested URL is all we have before a fetch, so it must find the row. */
		it("finds a row by the URL we asked for, not only the canonical one", async () => {
			const store = new PostgresDocumentStore(pool);
			await store.put({
				requestedUrl: "https://example.com/a?utm_source=x",
				finalUrl: "https://example.com/a",
				domain: "example.com",
				status: 200,
				extraction: EXTRACTION,
				etag: null,
			});

			expect(
				await store.get("https://example.com/a?utm_source=x"),
			).not.toBeNull();
		});

		it("reports an expired row as stale rather than hiding it", async () => {
			// Negative TTL, so it is already expired on insert — the row must still
			// come back, because its etag is what makes revalidation possible.
			const store = new PostgresDocumentStore(pool, -1_000);
			await store.put({
				requestedUrl: "https://example.com/a",
				finalUrl: "https://example.com/a",
				domain: "example.com",
				status: 200,
				extraction: EXTRACTION,
				etag: '"v1"',
			});

			const found = await store.get("https://example.com/a");
			expect(found).not.toBeNull();
			expect(found?.fresh).toBe(false);
			expect(found?.etag).toBe('"v1"');
		});

		it("touch makes a stale row fresh again", async () => {
			const stale = new PostgresDocumentStore(pool, -1_000);
			await stale.put({
				requestedUrl: "https://example.com/a",
				finalUrl: "https://example.com/a",
				domain: "example.com",
				status: 200,
				extraction: EXTRACTION,
				etag: '"v1"',
			});

			await new PostgresDocumentStore(pool, 60_000).touch(
				"https://example.com/a",
			);

			expect((await stale.get("https://example.com/a"))?.fresh).toBe(true);
		});

		/** Two fetches of one page are one row, not two. */
		it("upserts on the canonical url", async () => {
			const store = new PostgresDocumentStore(pool);
			for (const text of ["first version", "second version"]) {
				await store.put({
					requestedUrl: "https://example.com/a",
					finalUrl: "https://example.com/a",
					domain: "example.com",
					status: 200,
					extraction: { ...EXTRACTION, text },
					etag: null,
				});
			}

			const { rows } = await pool.query<{ count: string }>(
				"SELECT count(*) FROM web.documents",
			);
			expect(rows[0].count).toBe("1");
			expect((await store.get("https://example.com/a"))?.extraction.text).toBe(
				"second version",
			);
		});
	});

	describe("query cache", () => {
		it("round-trips candidates with their titles", async () => {
			const cache = new PostgresQueryCache(pool);
			await cache.put("Best   Laptop?", "tavily", [
				{ url: "https://a.example/1", title: "First" },
				{ url: "https://b.example/2", title: null },
			]);

			// Normalised on the way in, so a differently-typed query still hits.
			const found = await cache.get("best laptop", "tavily");
			expect(found).toEqual([
				{ url: "https://a.example/1", title: "First" },
				// null, not "" — `??` does not fall through an empty string, so a
				// blank here would render as a source with no title instead of its
				// domain.
				{ url: "https://b.example/2", title: null },
			]);
		});

		it("does not answer for a different provider", async () => {
			const cache = new PostgresQueryCache(pool);
			await cache.put("q", "tavily", [
				{ url: "https://a.example/1", title: null },
			]);
			expect(await cache.get("q", "anysearch")).toBeNull();
		});

		it("expires", async () => {
			const cache = new PostgresQueryCache(pool, -1_000);
			await cache.put("q", "tavily", [
				{ url: "https://a.example/1", title: null },
			]);
			expect(await cache.get("q", "tavily")).toBeNull();
		});

		it("refuses to cache an empty result", async () => {
			const cache = new PostgresQueryCache(pool);
			await cache.put("q", "tavily", []);
			expect(await cache.get("q", "tavily")).toBeNull();
		});
	});

	describe("query log", () => {
		it("records the query and the domains that answered it", async () => {
			await new PostgresQueryLog(pool).record("  What is ADS? ", [
				"example.com",
				"example.com",
				"other.example",
			]);

			const { rows } = await pool.query<{
				normalized_query: string;
				result_domains: string[];
			}>("SELECT normalized_query, result_domains FROM web.query_log");

			expect(rows).toHaveLength(1);
			expect(rows[0].normalized_query).toBe("what is ads");
			// Deduplicated: three sources from two domains is two domains.
			expect([...rows[0].result_domains].sort()).toEqual([
				"example.com",
				"other.example",
			]);
		});

		/**
		 * The privacy guarantee, asserted against the schema rather than the code.
		 *
		 * PLAN.md puts it "by construction rather than by convention — a value
		 * that cannot be stored cannot be stored by accident". A test that only
		 * checked the insert statement would pass on the day somebody adds the
		 * column and starts filling it; this fails the moment the column exists.
		 */
		it("has nowhere to put a user identity", async () => {
			const { rows } = await pool.query<{ column_name: string }>(
				`SELECT column_name FROM information_schema.columns
				  WHERE table_schema = 'web' AND table_name = 'query_log'`,
			);
			const columns = rows.map((row) => row.column_name);

			for (const forbidden of [
				"user_id",
				"session_id",
				"ip",
				"ip_address",
				"owner_id",
				"caller",
			]) {
				expect(columns).not.toContain(forbidden);
			}
		});

		it("does not expire — there is no expiry column to expire by", async () => {
			const { rows } = await pool.query<{ column_name: string }>(
				`SELECT column_name FROM information_schema.columns
				  WHERE table_schema = 'web' AND table_name = 'query_log'`,
			);
			expect(rows.map((row) => row.column_name)).not.toContain("expires_at");
		});
	});
});
