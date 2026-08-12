-- The web plane: large, churning, traffic-shaped.
--
-- Kept in its own schema so it can move to its own instance later without the
-- capability plane noticing. The only thing that will ever cross between them
-- is `web.documents.domain` → `capability.sites.domain`, and keeping that the
-- entire integration is what preserves the property that either plane can be
-- rebuilt, replaced or emptied on its own.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS web;

-- ---------------------------------------------------------------------------
-- documents — one row per URL we fetched and extracted
-- ---------------------------------------------------------------------------

CREATE TABLE web.documents (
	id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

	-- `url` is what we were given; `canonical_url` is what it resolved to after
	-- redirects and normalisation, and is the identity. Two result sets citing
	-- the same page by different URLs must not become two documents.
	url            text        NOT NULL,
	canonical_url  text        NOT NULL,

	-- Registrable domain, and the join key to the capability plane. Stored
	-- rather than derived at query time because that join runs on every query
	-- and a functional index on a parse is not free.
	domain         text        NOT NULL,

	title          text,
	extracted_text text,

	-- Of the extracted text, not the raw response: two fetches of a page whose
	-- only change was an ad slot are the same document for our purposes, and
	-- re-embedding them would be the waste the embedding cache exists to avoid.
	content_hash   text        NOT NULL,

	http_status    integer     NOT NULL,
	etag           text,
	fetched_at     timestamptz NOT NULL DEFAULT now(),

	-- Long TTL with revalidation. Null means "no opinion" — revalidate on the
	-- next sweep rather than treating it as fresh forever.
	expires_at     timestamptz,

	CONSTRAINT documents_canonical_url_key UNIQUE (canonical_url)
);

COMMENT ON COLUMN web.documents.domain IS
	'Join key to capability.sites.domain. The whole cross-plane integration.';

CREATE INDEX documents_domain_idx ON web.documents (domain);
CREATE INDEX documents_content_hash_idx ON web.documents (content_hash);

-- Partial: rows with no expiry are not candidates for the revalidation sweep,
-- and on a traffic-shaped corpus they are most of the table early on.
CREATE INDEX documents_expires_at_idx
	ON web.documents (expires_at)
	WHERE expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- passages — chunks of a document, and their embeddings
-- ---------------------------------------------------------------------------

CREATE TABLE web.passages (
	id            bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	document_id   bigint  NOT NULL REFERENCES web.documents (id) ON DELETE CASCADE,
	ordinal       integer NOT NULL,
	text          text    NOT NULL,

	-- Of this passage's text alone. With model_version it is the embedding
	-- cache key: the same paragraph appearing in two documents is embedded
	-- once, and re-embedding it is pure waste.
	content_hash  text    NOT NULL,

	-- 1024 dimensions is a pin, not a default. Changing embedding model to one
	-- with a different width is a migration and a re-embed, which is why
	-- model_version is stored beside the vector rather than assumed.
	embedding     vector(1024),
	model_version text,

	CONSTRAINT passages_document_ordinal_key UNIQUE (document_id, ordinal),

	-- An embedding with no model version cannot be reused or invalidated — it
	-- is a vector nobody can say the provenance of. Reject the pair rather than
	-- discovering it during a model upgrade.
	CONSTRAINT passages_embedding_has_provenance
		CHECK ((embedding IS NULL) = (model_version IS NULL))
);

CREATE INDEX passages_document_id_idx ON web.passages (document_id);

-- The embedding cache lookup: "have we already embedded this text with this
-- model?". Partial, because a passage without an embedding has nothing to
-- reuse.
CREATE INDEX passages_reuse_idx
	ON web.passages (content_hash, model_version)
	WHERE embedding IS NOT NULL;

-- HNSW over cosine distance. Built now, on an empty table, where it costs
-- nothing; building it later against a full corpus is an outage.
CREATE INDEX passages_embedding_idx
	ON web.passages
	USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- query_cache — short TTL, because rankings move
-- ---------------------------------------------------------------------------

CREATE TABLE web.query_cache (
	query_hash       text        NOT NULL,

	-- Kept alongside the hash so the cache is legible: a table of hashes is
	-- unreadable exactly when somebody is trying to work out why a query
	-- returned what it did.
	normalized_query text        NOT NULL,

	-- Part of the key. Two upstream providers answer the same query
	-- differently, and collapsing them would make the cache serve whichever
	-- vendor happened to be asked first.
	provider         text        NOT NULL,

	result_urls      text[]      NOT NULL,
	fetched_at       timestamptz NOT NULL DEFAULT now(),
	expires_at       timestamptz NOT NULL,

	PRIMARY KEY (query_hash, provider)
);

CREATE INDEX query_cache_expires_at_idx ON web.query_cache (expires_at);

-- ---------------------------------------------------------------------------
-- query_log — permanent, and the reason it is a separate table
-- ---------------------------------------------------------------------------

CREATE TABLE web.query_log (
	id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	normalized_query text        NOT NULL,
	occurred_at      timestamptz NOT NULL DEFAULT now(),

	-- The domains that answered. This is the column the whole table exists
	-- for: it is the crawl list, ranked by real demand, on the day owning an
	-- index becomes affordable.
	result_domains   text[]      NOT NULL DEFAULT '{}'
);

COMMENT ON TABLE web.query_log IS
	'Permanent. Never expires, unlike query_cache — this is the seed corpus for '
	'owning an index later, weighted by real demand. '
	'PRIVACY: there is no user id, session id or address column, and that is by '
	'construction rather than by convention — a value that cannot be stored '
	'cannot be stored by accident. Queries are sensitive (health, legal, '
	'financial), so retention is on the normalised text alone. Any future need '
	'to attribute a query to a person is a new table and a new argument, not a '
	'column added here.';

CREATE INDEX query_log_occurred_at_idx ON web.query_log (occurred_at);

-- Answers "which domains keep appearing", which is the query this table is
-- read by. A btree cannot serve it; array containment needs GIN.
CREATE INDEX query_log_result_domains_idx
	ON web.query_log
	USING gin (result_domains);
