import type pg from "pg";

/**
 * The demand-driven crawl scheduler.
 *
 * Rather than crawling the web breadth-first, Cheela expands around what people
 * actually search for. The TDS's priority formula:
 *
 *     0.35 × Demand + 0.30 × Authority + 0.20 × Freshness + 0.15 × GraphImportance
 *
 * Repeated searches for "Australian wildfire" are what make government
 * reports, Wikipedia and news archives on that subject worth fetching — the
 * query log is the demand signal, and it is the one asset here that no vendor
 * can sell us.
 */

export const WEIGHTS = {
	demand: 0.35,
	authority: 0.3,
	freshness: 0.2,
	graphImportance: 0.15,
} as const;

export function priority(terms: {
	demand: number;
	authority: number;
	freshness: number;
	graphImportance: number;
}): number {
	return (
		WEIGHTS.demand * terms.demand +
		WEIGHTS.authority * terms.authority +
		WEIGHTS.freshness * terms.freshness +
		WEIGHTS.graphImportance * terms.graphImportance
	);
}

export type PlanResult = { scored: number; promoted: number };

/**
 * Recomputes the frontier's priorities from current demand and promotes the
 * top of it.
 *
 * Demand is measured over a 30-day window rather than all time: a topic that
 * was searched a thousand times last year and never since is not demand, it is
 * history, and a frontier that cannot tell the difference keeps re-crawling
 * last year's news.
 */
export async function plan(pool: pg.Pool, limit = 500): Promise<PlanResult> {
	const scored = await pool.query(
		`WITH demand AS (
			SELECT unnest(result_domains) AS domain, count(*)::real AS hits
			  FROM search.query_log
			 WHERE occurred_at > now() - interval '30 days'
			 GROUP BY 1
		), scaled AS (
			SELECT domain,
			       -- log1p and normalised against the busiest domain, so one
			       -- runaway topic cannot make every other demand score zero.
			       ln(1 + hits) / NULLIF(max(ln(1 + hits)) OVER (), 0) AS demand
			  FROM demand
		)
		UPDATE crawl.frontier f
		   SET demand = COALESCE(s.demand, 0),
		       priority = $1 * COALESCE(s.demand, 0)
		                + $2 * f.authority
		                + $3 * f.freshness
		                + $4 * f.graph_importance
		  FROM scaled s
		 WHERE s.domain = f.domain
		   AND f.state = 'pending'`,
		[
			WEIGHTS.demand,
			WEIGHTS.authority,
			WEIGHTS.freshness,
			WEIGHTS.graphImportance,
		],
	);

	// Promotion is a claim on work: `FOR UPDATE SKIP LOCKED` means two
	// schedulers running at once hand out different rows rather than the same
	// row twice.
	const promoted = await pool.query(
		`WITH ready AS (
			SELECT url FROM crawl.frontier
			 WHERE state = 'pending' AND next_attempt_at <= now()
			 ORDER BY priority DESC, next_attempt_at
			 LIMIT $1
			 FOR UPDATE SKIP LOCKED
		)
		UPDATE crawl.frontier f
		   SET state = 'queued', attempts = f.attempts + 1
		  FROM ready
		 WHERE f.url = ready.url
		RETURNING f.url`,
		[limit],
	);

	return { scored: scored.rowCount ?? 0, promoted: promoted.rowCount ?? 0 };
}

/** Adds a URL to the frontier without disturbing one already there. */
export async function enqueue(
	pool: pg.Pool,
	entries: { url: string; domain: string; authority?: number }[],
): Promise<void> {
	if (entries.length === 0) return;
	await pool.query(
		`INSERT INTO crawl.frontier (url, domain, authority)
		 SELECT * FROM unnest($1::text[], $2::text[], $3::real[])
		 ON CONFLICT (url) DO NOTHING`,
		[
			entries.map((entry) => entry.url),
			entries.map((entry) => entry.domain),
			entries.map((entry) => entry.authority ?? 0.5),
		],
	);
}
