import pg from "pg";
import { config } from "../../shared/config.js";

/**
 * The metadata pool.
 *
 * `statement_timeout` is set on the connection rather than left to the server
 * default: this database holds the graph, and a graph query that has gone
 * quadratic should be cancelled by the database rather than by a user closing
 * a tab.
 */
export const pool = new pg.Pool({
	connectionString: config.DATABASE_URL,
	max: config.DATABASE_POOL_MAX,
	connectionTimeoutMillis: 5000,
	idleTimeoutMillis: 30_000,
	statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
});

// A pool that emits an unhandled 'error' takes the process down. An idle
// client dropped by the server is routine — Cloud SQL does it — and must not
// be fatal.
pool.on("error", () => {});

export async function databaseReachable(): Promise<boolean> {
	try {
		await pool.query("SELECT 1");
		return true;
	} catch {
		return false;
	}
}
