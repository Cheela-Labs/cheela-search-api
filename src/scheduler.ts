import { pool } from "./infra/db/pool.js";
import { plan, WEIGHTS } from "./services/crawler/index.js";
import { logger } from "./shared/logger.js";

/**
 * The demand-driven crawl scheduler, as a Cloud Run Job on Cloud Scheduler.
 *
 * A Job rather than a loop in the worker because scheduling is a periodic
 * *decision* — recompute priorities, promote the top of the frontier — not a
 * stream to follow. Running it on a timer also means its cost is visible and
 * bounded, which a background loop's is not.
 */
async function main(): Promise<void> {
	const started = Date.now();
	try {
		const result = await plan(pool);
		logger.info(
			{
				scored: result.scored,
				promoted: result.promoted,
				weights: WEIGHTS,
				ms: Date.now() - started,
			},
			"crawl plan complete",
		);
	} finally {
		await pool.end();
	}
}

main().catch((error) => {
	logger.error(
		{ error: error instanceof Error ? error.message : error },
		"crawl planning failed",
	);
	process.exit(1);
});
