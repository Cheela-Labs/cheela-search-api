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

/**
 * Records what was asked and what answered it.
 *
 * This is the demand signal, and until it existed the frontier had none: `plan`
 * below joins `search.query_log` to score demand, nothing ever inserted a row,
 * so the join matched nothing and `priority` collapsed to `0.30 × authority`.
 * The engine called itself demand-driven while ranking on authority alone.
 *
 * Written from the worker rather than the request path — the user should not
 * wait on it — and it carries no identity, because the table has no column for
 * one. See the comment on `search.query_log` for why that is structural.
 */
export async function recordQuery(
	pool: pg.Pool,
	entry: {
		normalizedQuery: string;
		intent: string;
		resultDomains: string[];
		servedFrom: string;
	},
): Promise<void> {
	await pool.query(
		`INSERT INTO search.query_log
		   (normalized_query, intent, result_domains, served_from)
		 VALUES ($1, $2, $3, $4)`,
		[
			entry.normalizedQuery,
			entry.intent,
			entry.resultDomains,
			entry.servedFrom,
		],
	);
}

export type ClaimedUrl = { url: string; domain: string };

/**
 * Takes work off the frontier.
 *
 * `plan` promotes rows from `pending` to `queued`; this is the consumer that
 * was missing, so promotion led nowhere and the scheduler ran hourly against a
 * table nobody read.
 *
 * `FOR UPDATE SKIP LOCKED` so two workers running at once take different rows
 * rather than the same row twice, and the state moves to `fetching` inside the
 * same statement — a row that is merely selected is a row a second worker will
 * also select.
 */
export async function claim(
	pool: pg.Pool,
	limit: number,
): Promise<ClaimedUrl[]> {
	const { rows } = await pool.query<ClaimedUrl>(
		`WITH taken AS (
			SELECT url FROM crawl.frontier
			 WHERE state = 'queued'
			 ORDER BY priority DESC, next_attempt_at
			 LIMIT $1
			 FOR UPDATE SKIP LOCKED
		)
		UPDATE crawl.frontier f
		   SET state = 'fetching'
		  FROM taken
		 WHERE f.url = taken.url
		RETURNING f.url, f.domain`,
		[limit],
	);
	return rows;
}

/**
 * Closes out a claimed URL.
 *
 * A transport failure goes back to `pending` with exponential backoff, because
 * asking again later is the whole remedy. A refusal — robots, a JavaScript
 * shell, a page too short to index — is terminal: it will give the same answer
 * however many times it is asked, and requeueing it is how a frontier fills
 * with work that can never succeed.
 */
export async function complete(
	pool: pg.Pool,
	url: string,
	outcome: "indexed" | "duplicate" | "refused" | "failed",
	reason = "",
): Promise<void> {
	const terminal = outcome !== "failed";
	await pool.query(
		`UPDATE crawl.frontier
		    SET state = $2,
		        last_error = NULLIF($3, ''),
		        next_attempt_at = CASE
		          WHEN $2 = 'pending'
		          THEN now() + (least(power(2, attempts), 64) || ' hours')::interval
		          ELSE next_attempt_at END
		  WHERE url = $1`,
		[url, terminal ? outcome : "pending", reason],
	);
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
