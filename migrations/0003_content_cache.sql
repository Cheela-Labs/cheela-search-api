-- The content cache becomes readable, not just writable.
--
-- `web.documents` has existed since 0001 and nothing has ever read or written
-- it: until now every query re-fetched every page. Two things were missing
-- before it could serve a cached page back without losing information.

-- 1 · The page's own og:image.
--
-- `Extraction` carries it and the discovery answer renders it — that is the
-- whole point of "the pages' own images", where a result is paired with an
-- image the page itself declared rather than one that merely matched the query.
-- Caching a document without this column would serve a cache hit that silently
-- dropped the image, so the feature would work on a miss and degrade on a hit:
-- the worst shape of bug, because it improves as the cache gets colder.
ALTER TABLE web.documents ADD COLUMN IF NOT EXISTS image text;

-- 2 · A lookup path for the URL we asked for.
--
-- The unique key is `canonical_url`, which is what a page calls itself — and is
-- only known *after* fetching it. Before a fetch we have the URL an upstream
-- provider handed us, so the cache has to be searchable by that too, or every
-- lookup misses and the table stays decorative.
--
-- Two requested URLs that canonicalise to one page still collapse onto one row,
-- because the upsert conflicts on `canonical_url`. The row keeps whichever
-- `url` was written last, so the other requested URL then misses. That is a
-- lost hit and never a wrong answer, and fixing it properly means a second
-- table of aliases — worth doing when the hit rate says it is worth doing.
CREATE INDEX IF NOT EXISTS documents_url_idx ON web.documents (url);

-- 3 · Candidate titles, alongside the URLs already stored.
--
-- `pipeline.ts` resolves a source's title as
-- `extraction.title ?? candidate.title ?? domain`, so the upstream provider's
-- title is a real fallback for a page that extracts cleanly but declares no
-- title of its own. Caching only URLs would make that fallback unavailable on a
-- hit, and the visible effect would be source titles quietly degrading to bare
-- hostnames as the cache warms — again the worst shape, where the feature looks
-- correct until the optimisation starts working.
--
-- Paired with `result_urls` by index rather than stored as objects, because the
-- existing column is `text[] NOT NULL` and splitting one list into two parallel
-- ones is a smaller change than migrating the column's type. A length mismatch
-- is treated by the reader as "no titles", never as a misalignment.
ALTER TABLE web.query_cache ADD COLUMN IF NOT EXISTS result_titles text[];
