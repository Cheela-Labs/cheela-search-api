import { Pool } from "pg";
import { config } from "../../shared/config";

/**
 * The connection pool.
 *
 * Sized against Cloud Run's shape rather than a guess: an instance handles up
 * to `--concurrency` requests, each of which touches the database a small
 * number of times, and `--max-instances` of them can exist at once. The
 * product of pool size and instance count is what the database actually sees,
 * so raising either without the other in mind is how a scale-to-zero service
 * exhausts a small Postgres during its first traffic spike.
 *
 * `statement_timeout` is set here rather than left to the server's default of
 * none. A query with no timeout on a request path with one is a query that
 * outlives the request that wanted it, holding a connection nobody is waiting
 * on.
 */
export const pool = new Pool({
	connectionString: config.DATABASE_URL,
	max: config.DATABASE_POOL_MAX,
	// A connection that cannot be established quickly is a database under load;
	// queuing behind it makes that worse.
	connectionTimeoutMillis: 5_000,
	idleTimeoutMillis: 30_000,
	statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
});

/**
 * A liveness check for `/health`, not a readiness gate.
 *
 * Deliberately `SELECT 1` and not a real query: the question is whether the
 * pool can reach the database at all, and anything more specific turns a health
 * check into a second, slower place for schema problems to surface.
 */
export async function databaseReachable(): Promise<boolean> {
	try {
		await pool.query("SELECT 1");
		return true;
	} catch {
		return false;
	}
}
