-- The capability plane — Phase 1 of PLAN.md, first slice.
--
-- Its own schema, not `web`, and that separation is the point: "split so the web
-- side can move out later without touching the capability side". The only join
-- between them is `documents.domain → sites.domain`, and every temptation to
-- make it smarter costs that property.
--
-- This creates three of the plan's six capability tables. `enrichment`,
-- `phrase_vectors` and `invocations` serve capability *retrieval* — matching a
-- query to an action — which is a different feature from showing what a site in
-- the results can do. Columns here keep the plan's names so the rest is
-- additive rather than a rewrite.

CREATE SCHEMA IF NOT EXISTS capability;

-- ---------------------------------------------------------------------------
-- sites — one row per domain we have looked at, or intend to
-- ---------------------------------------------------------------------------
CREATE TABLE capability.sites (
	domain            text        PRIMARY KEY,
	-- How we came to know about it. `traffic` is the opportunistic probe of
	-- domains that appeared in a result set — weighted by what people actually
	-- search for, which beats any static ranking list.
	discovery_method  text        NOT NULL DEFAULT 'traffic',
	-- Where the manifest read got to. `unknown` until probed; `absent` is the
	-- normal outcome for most of the web and is never an alert.
	adp_state         text        NOT NULL DEFAULT 'unknown',
	first_seen_at     timestamptz NOT NULL DEFAULT now(),
	last_probed_at    timestamptz,
	-- Due time for the next probe. A 404 means recheck in 30 days rather than
	-- never: a site that publishes a manifest tomorrow should be found.
	next_probe_at     timestamptz NOT NULL DEFAULT now(),

	CONSTRAINT sites_adp_state_known CHECK (
		adp_state IN ('unknown', 'absent', 'valid', 'invalid', 'unreadable')
	)
);

-- The probe job's whole query: what is due, oldest first.
CREATE INDEX sites_next_probe_at_idx ON capability.sites (next_probe_at);

COMMENT ON COLUMN capability.sites.domain IS
	'Join key to web.documents.domain. The whole cross-plane integration.';

-- ---------------------------------------------------------------------------
-- manifests — kept, never dropped
-- ---------------------------------------------------------------------------
CREATE TABLE capability.manifests (
	id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	domain            text        NOT NULL REFERENCES capability.sites (domain) ON DELETE CASCADE,
	url               text        NOT NULL,
	-- Raw, verbatim, whether or not it validated. PLAN.md: "Round-trip unknown
	-- fields and `extensions` verbatim. A field dropped today is a feature that
	-- cannot ship tomorrow without a full re-crawl." An invalid manifest is
	-- kept for the same reason — it is evidence about the spec in the wild.
	raw_json          jsonb       NOT NULL,
	content_hash      text        NOT NULL,
	spec_version      text,
	valid             boolean     NOT NULL,
	validation_errors jsonb,
	fetched_at        timestamptz NOT NULL DEFAULT now(),
	etag              text,

	CONSTRAINT manifests_domain_hash_key UNIQUE (domain, content_hash)
);

CREATE INDEX manifests_domain_idx ON capability.manifests (domain);

-- ---------------------------------------------------------------------------
-- capabilities — what a site says it can do
-- ---------------------------------------------------------------------------
CREATE TABLE capability.capabilities (
	id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	manifest_id      bigint      NOT NULL REFERENCES capability.manifests (id) ON DELETE CASCADE,
	domain           text        NOT NULL REFERENCES capability.sites (domain) ON DELETE CASCADE,
	name             text        NOT NULL,
	invocation_name  text,
	version          text,
	description      text,
	transport        text,
	auth             text,
	address          text,
	-- Ours, derived from structure — the verb in the name, the shape of the
	-- schemas, the endpoint. **Never taken from the manifest's prose.**
	-- PLAN.md's invariant: manifest text can only lower a capability's
	-- privilege, never raise it.
	effects          text        NOT NULL DEFAULT 'unknown',
	-- False for a transport or auth we do not speak. It stays indexed anyway:
	-- "We cannot call it, but the site still does this and the user should
	-- still be told. Not-invocable-by-us is a property of the result, not a
	-- reason to hide it."
	invocable_by_us  boolean     NOT NULL DEFAULT false,
	deprecated       boolean     NOT NULL DEFAULT false,
	-- Everything the spec carried that we do not have a column for.
	extensions       jsonb,

	CONSTRAINT capabilities_effects_known CHECK (
		effects IN ('read', 'write-reversible', 'write-irreversible', 'financial', 'unknown')
	)
);

-- The query-time read: every capability for the domains in a result set.
CREATE INDEX capabilities_domain_idx ON capability.capabilities (domain);
CREATE INDEX capabilities_manifest_id_idx ON capability.capabilities (manifest_id);
