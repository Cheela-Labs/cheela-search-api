-- Corrects what `web.documents.domain` means.
--
-- 0001 called it the "registrable domain" — eTLD+1, so `docs.example.com` and
-- `example.com` would both store `example.com`. Step 4 settled it the other
-- way, and this records the decision where the next reader will find it.
--
-- It is the **host**, verbatim. ADS manifests live at a specific host's
-- `/.well-known/agent-discovery.json`, so `docs.example.com` and `example.com`
-- can publish entirely different capabilities. Collapsing them to eTLD+1 would
-- join a document to a declaration its site never made — which is the one
-- mistake the capability plane cannot afford, since the whole cross-plane
-- integration is this column.
--
-- It also removes a dependency: eTLD+1 needs the public suffix list to be
-- correct, and `new URL(...).hostname` needs nothing.
--
-- A comment-only migration rather than an edit to 0001, because migrations are
-- forward-only. 0001 has only ever run on a developer's machine, which makes
-- amending it tempting and still wrong: the discipline is worth more than the
-- one file it costs, and the ledger should show that this was reconsidered.

COMMENT ON COLUMN web.documents.domain IS
	'Host, verbatim — not the registrable domain. Join key to '
	'capability.sites.domain, and the whole cross-plane integration. ADS '
	'manifests are per-host, so docs.example.com and example.com are different '
	'sites that may declare different capabilities.';
