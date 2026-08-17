-- The metadata plane.
--
-- Postgres holds what a graph and a ledger need. It deliberately holds no
-- index: retrieval is Vespa's job, and the moment a search request reads a row
-- from here on its critical path, this database is in the latency budget and
-- the architecture's separation has quietly stopped being true.
--
-- Nothing here is on the request path except `capability.capabilities`, which
-- is joined by domain to decorate results, and that join is by primary key.

CREATE SCHEMA IF NOT EXISTS search;
CREATE SCHEMA IF NOT EXISTS graph;
CREATE SCHEMA IF NOT EXISTS capability;
CREATE SCHEMA IF NOT EXISTS crawl;

-- ---------------------------------------------------------------------------
-- Documents: what we have fetched, not what we can search.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS search.documents (
	doc_id         text PRIMARY KEY,
	url            text NOT NULL,
	-- The deduplication key. Two URLs that canonicalize to the same string are
	-- one document, which is why this and not `url` carries the constraint.
	canonical_url  text NOT NULL UNIQUE,
	-- The host verbatim, not eTLD+1: the join key to capability.sites, where a
	-- manifest at docs.example.com is not a claim about example.com.
	domain         text NOT NULL,
	title          text NOT NULL DEFAULT '',
	language       text NOT NULL DEFAULT 'en',

	-- Exact-duplicate detection. Two identical bodies at different URLs.
	content_hash   text,
	-- Near-duplicate detection: 64-bit SimHash, compared by Hamming distance.
	-- Signed because Postgres has no unsigned 64-bit integer; the sign bit is
	-- data, so readers must not treat this as a magnitude.
	simhash        bigint,

	http_status    integer,
	etag           text,
	fetched_at     timestamptz NOT NULL DEFAULT now(),
	-- The TDS's 24-hour document cache. Revalidated with If-None-Match rather
	-- than refetched, so an unchanged page costs one 304.
	expires_at     timestamptz,
	-- Null is the common case and must never be read as 1970.
	published_at   timestamptz,
	indexed_at     timestamptz,
	authority      real NOT NULL DEFAULT 0.5,
	-- Where the raw HTML was archived, so re-extraction never needs a re-crawl.
	raw_object     text
);

CREATE INDEX IF NOT EXISTS documents_domain_idx ON search.documents (domain);
CREATE INDEX IF NOT EXISTS documents_content_hash_idx ON search.documents (content_hash);
CREATE INDEX IF NOT EXISTS documents_simhash_idx ON search.documents (simhash);
CREATE INDEX IF NOT EXISTS documents_expires_at_idx ON search.documents (expires_at)
	WHERE expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The query log. Permanent, and deliberately anonymous.
-- ---------------------------------------------------------------------------

-- There is no user column, no session column and no address column, and that
-- is a structural decision rather than a policy one: a promise not to look is
-- only as good as the next person's discipline, and a column that does not
-- exist cannot be read by a subpoena, a breach, or a well-meaning feature.
--
-- What this is for: it is the demand signal the crawl scheduler ranks on, and
-- the list of what to fetch first on the day owning an index becomes
-- affordable. That value is aggregate. Identity would add nothing to it.
CREATE TABLE IF NOT EXISTS search.query_log (
	id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	normalized_query  text NOT NULL,
	intent            text,
	occurred_at       timestamptz NOT NULL DEFAULT now(),
	result_domains    text[] NOT NULL DEFAULT '{}',
	served_from       text
);

CREATE INDEX IF NOT EXISTS query_log_occurred_at_idx ON search.query_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS query_log_normalized_idx ON search.query_log (normalized_query);

-- ---------------------------------------------------------------------------
-- The knowledge graph. Postgres is the system of record; Vespa holds a
-- searchable projection of it.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS graph.entities (
	entity_id        text PRIMARY KEY,
	name             text NOT NULL,
	-- Person | Organization | Product | Event | Place | Technology | Capability
	node_type        text NOT NULL,
	aliases          text[] NOT NULL DEFAULT '{}',
	description      text NOT NULL DEFAULT '',
	popularity       real NOT NULL DEFAULT 0,
	graph_importance real NOT NULL DEFAULT 0,
	first_seen_at    timestamptz NOT NULL DEFAULT now(),
	updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS entities_name_idx ON graph.entities (lower(name));
CREATE INDEX IF NOT EXISTS entities_aliases_idx ON graph.entities USING gin (aliases);
CREATE INDEX IF NOT EXISTS entities_type_idx ON graph.entities (node_type);

CREATE TABLE IF NOT EXISTS graph.edges (
	id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	source_id   text NOT NULL REFERENCES graph.entities (entity_id) ON DELETE CASCADE,
	-- founded | owned_by | located_in | occurred_in | part_of |
	-- manufactured_by | related_to
	relation    text NOT NULL,
	target_id   text NOT NULL REFERENCES graph.entities (entity_id) ON DELETE CASCADE,
	-- Every edge stores its confidence, as both specifications require. An
	-- edge extracted once from one sentence and an edge seen in fifty
	-- documents are not the same claim, and ranking has to be able to tell.
	confidence  real NOT NULL DEFAULT 0.5,
	-- How many documents asserted this. The evidence behind the confidence.
	observations integer NOT NULL DEFAULT 1,
	created_at  timestamptz NOT NULL DEFAULT now(),
	updated_at  timestamptz NOT NULL DEFAULT now(),

	CONSTRAINT edges_unique UNIQUE (source_id, relation, target_id)
);

CREATE INDEX IF NOT EXISTS edges_source_idx ON graph.edges (source_id);
CREATE INDEX IF NOT EXISTS edges_target_idx ON graph.edges (target_id);

-- Which documents mentioned which entity. Feeds entity boost and the
-- scheduler's graph-importance term.
CREATE TABLE IF NOT EXISTS graph.mentions (
	doc_id     text NOT NULL,
	entity_id  text NOT NULL REFERENCES graph.entities (entity_id) ON DELETE CASCADE,
	confidence real NOT NULL DEFAULT 0.5,
	PRIMARY KEY (doc_id, entity_id)
);

CREATE INDEX IF NOT EXISTS mentions_entity_idx ON graph.mentions (entity_id);

-- ---------------------------------------------------------------------------
-- Capabilities.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS capability.sites (
	domain          text PRIMARY KEY,
	discovery_method text NOT NULL DEFAULT 'traffic',
	state           text NOT NULL DEFAULT 'unknown',
	first_seen_at   timestamptz NOT NULL DEFAULT now(),
	last_probed_at  timestamptz,
	next_probe_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sites_next_probe_idx ON capability.sites (next_probe_at);

CREATE TABLE IF NOT EXISTS capability.capabilities (
	cap_id          text PRIMARY KEY,
	domain          text NOT NULL REFERENCES capability.sites (domain) ON DELETE CASCADE,
	invocation_name text NOT NULL,
	title           text NOT NULL,
	description     text NOT NULL DEFAULT '',
	provider        text NOT NULL DEFAULT '',
	auth            text NOT NULL DEFAULT 'none',
	transport       text NOT NULL DEFAULT 'https',
	address         text,
	-- read | write-reversible | write-irreversible | financial | unknown.
	-- Derived by us from the verb, never taken from the manifest: a manifest
	-- that calls a payment "read" does not make it one.
	effects         text NOT NULL DEFAULT 'unknown',
	-- Whether *we* could invoke it. Also ours, never the manifest's.
	callable        boolean NOT NULL DEFAULT false,
	examples        text[] NOT NULL DEFAULT '{}',
	intents         text[] NOT NULL DEFAULT '{}',
	popularity      real NOT NULL DEFAULT 0,
	registered_at   timestamptz NOT NULL DEFAULT now(),
	updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS capabilities_domain_idx ON capability.capabilities (domain);

-- ---------------------------------------------------------------------------
-- The crawl frontier.
-- ---------------------------------------------------------------------------

-- Redis Streams is the *queue* — what a worker is working on now. This is the
-- durable *frontier*: what is known, what it scored, and what happened. They
-- are separate because a queue is transient by design and the frontier is the
-- thing that must survive a Redis restart.
CREATE TABLE IF NOT EXISTS crawl.frontier (
	url              text PRIMARY KEY,
	domain           text NOT NULL,
	-- The TDS's priority terms, stored so a scheduling decision can be
	-- explained after the fact rather than only recomputed.
	demand           real NOT NULL DEFAULT 0,
	authority        real NOT NULL DEFAULT 0,
	freshness        real NOT NULL DEFAULT 0,
	graph_importance real NOT NULL DEFAULT 0,
	-- 0.35D + 0.30A + 0.20F + 0.15G, materialised for ordering.
	priority         real NOT NULL DEFAULT 0,
	state            text NOT NULL DEFAULT 'pending',
	attempts         integer NOT NULL DEFAULT 0,
	last_error       text,
	enqueued_at      timestamptz NOT NULL DEFAULT now(),
	next_attempt_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS frontier_ready_idx
	ON crawl.frontier (priority DESC, next_attempt_at)
	WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS frontier_domain_idx ON crawl.frontier (domain);

-- Per-host fetch outcomes. What this host does when we ask it for a page,
-- which is what decides whether to spend a fetch slot on it next time.
CREATE TABLE IF NOT EXISTS crawl.domain_stats (
	domain       text PRIMARY KEY,
	fetches      bigint NOT NULL DEFAULT 0,
	extracted    bigint NOT NULL DEFAULT 0,
	refused      bigint NOT NULL DEFAULT 0,
	empty        bigint NOT NULL DEFAULT 0,
	slow         bigint NOT NULL DEFAULT 0,
	last_seen_at timestamptz NOT NULL DEFAULT now()
);
