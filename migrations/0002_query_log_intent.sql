-- Making the two write-only columns readable.
--
-- `search.query_log` has recorded `intent` and `served_from` on every row since
-- the table was created, and nothing has ever read either. The three consumers
-- that exist group by `result_domains` (the crawl scheduler's demand term) or
-- by `normalized_query` (the news feeder, and the domain_preference view).
-- Neither column has an index, because nothing has needed one.
--
-- Between them they answer the question the corpus work has been guessing at:
-- *which intents does our own index fail to answer*. `served_from` is set from
-- `retrieval.servedFrom`, so a row that says `external` is a search where the
-- index had nothing good enough and a paid provider was called instead. That is
-- not a proxy for the gap — it is the gap, already measured, once per query,
-- for as long as the table has existed.

-- `(intent, occurred_at DESC)` rather than `(intent)`: every aggregate below is
-- windowed, and the existing `query_log_occurred_at_idx` cannot narrow by intent
-- first. Partial on NOT NULL because the column is nullable and a row without an
-- intent contributes to no per-intent number.
CREATE INDEX IF NOT EXISTS query_log_intent_idx
	ON search.query_log (intent, occurred_at DESC)
	WHERE intent IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The coverage view
-- ---------------------------------------------------------------------------
--
-- One row per intent over a 30-day window, matching the window the crawl
-- scheduler already uses for demand so the two cannot disagree about what
-- "recent" means.
--
-- `external_share` is the number to act on. It is the fraction of searches of
-- this intent that the index could not answer alone, and the crawl budget
-- belongs where it is highest — an intent already answered from the index is an
-- intent that does not need more pages.
--
-- `served_from` is nullable and a NULL is not evidence either way, so those rows
-- are excluded from the ratio rather than counted as a success. `answerable` and
-- `queries` are reported separately for exactly that reason: a large gap over
-- four queries is noise, and the denominator is what says so.
CREATE OR REPLACE VIEW search.intent_coverage AS
SELECT
	intent,
	count(*) AS queries,
	count(*) FILTER (WHERE served_from IS NOT NULL) AS answerable,
	count(*) FILTER (WHERE served_from = 'index') AS from_index,
	count(*) FILTER (WHERE served_from = 'mixed') AS from_mixed,
	count(*) FILTER (WHERE served_from = 'external') AS from_external,
	-- NULLIF so an intent with no `served_from` at all reports NULL rather than
	-- dividing by zero — and NULL reads as "not measured", which is the truth.
	round(
		count(*) FILTER (WHERE served_from IN ('external', 'mixed'))::numeric
			/ NULLIF(count(*) FILTER (WHERE served_from IS NOT NULL), 0),
		4
	) AS external_share,
	count(DISTINCT normalized_query) AS distinct_queries,
	max(occurred_at) AS last_seen_at
FROM search.query_log
WHERE occurred_at > now() - interval '30 days'
  AND intent IS NOT NULL
GROUP BY intent;

COMMENT ON VIEW search.intent_coverage IS
	'Per-intent index coverage over 30 days. external_share is the fraction of '
	'searches this index could not answer alone, and is the crawl budget signal. '
	'NULL external_share means no row carried served_from, which is unmeasured '
	'rather than good.';

-- ---------------------------------------------------------------------------
-- Grant, for an operator to run out of band
-- ---------------------------------------------------------------------------
--
-- Same convention as `apps/search-console/migrations/0001_console_plane.sql`:
-- roles are cluster-wide and creating or granting on them needs privileges the
-- application's own user should not hold, so this is documentation rather than
-- something the runner executes.
--
-- `GRANT ALL ON ALL TABLES` was a one-time grant over the tables that existed
-- when it ran. A view created afterwards is not covered by it, and the failure
-- is silent in the direction that matters: the crawl scheduler reads this in
-- Phase 3, finds it cannot, and falls back to equal shares while logging
-- nothing anybody looks at.
--
--   GRANT SELECT ON search.intent_coverage TO search_console;
