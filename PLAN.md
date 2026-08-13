# apps/search-api — build plan

**Status:** Phase 0 — deployed; steps 0–4 accepted; 5 and 6 code-done; step 7 remaining · **Scope:** Phase 0 through Phase 2
**Consumer:** `apps/search-web`, which already speaks this service's event contract
**Host:** Google Cloud Run

This is the query plane: query in, cited answer out, with an action layer where
a site's manifest says one exists.

It is also the only architecture document for search. An earlier
`docs/capability-search-architecture.md` argued the shape and was deleted once
this file carried everything from it that still applied; the decisions below
are what survived, including the two places this design overruled it. What
follows is what gets built in this directory, in what order, and what has to be
true before the next thing starts.

---

## What this service is, and what it is not

**It is** the request path. Route the query, retrieve, rank, compose, stream.
One stateless process, holding no session.

**It is not** the crawler. Manifest fetching and content crawl-ahead run on
their own schedule against the same database and belong in `apps/crawler`.
Putting them here would tie a background job's memory profile and failure modes
to the latency of a user-facing request, and the first slow crawl would take the
search box down with it.

**It is not** the control plane. `apps/server` and this service do not talk. See
Decision 03 — that is a stronger position than it was, and it is deliberate.

---

## Decisions

Recorded because each one closes a question that was open, and the reasoning is
worth more than the conclusion when somebody reopens it.

> ### Decision 01 — Rent the index. Own the query log.
> **2026-08-12.** No Common Crawl, no owned corpus, not yet. We have neither the
> budget nor the infrastructure, and a monthly crawl is stale for exactly the
> queries the action layer exists to serve.
>
> What we own instead is the **query log**, and it is a different object from
> the query cache. The cache expires in hours because rankings move. The log
> never expires, because it is the list of domains to crawl first on the day
> owning an index becomes affordable — weighted by real demand, which is better
> targeting than any ranked domain list would have given us.
>
> Break-even against a rented search API lands near **100k queries/month**.
> Below that, renting wins outright. Revisit there, with a log that says exactly
> what to fetch.

> ### Decision 02 — Google Cloud Run, and the SSRF policy is now the highest-severity code here.
> **2026-08-12.** Cloud Run streams responses properly, which SSE needs, and
> scales to zero, which matters while the budget is the constraint. Deploys from
> the `cheela-search-api` mirror like every other app.
>
> The consequence that matters: **`169.254.169.254` is GCP's metadata server and
> it hands out service-account access tokens.** This service fetches
> attacker-influenceable URLs — result URLs from an SEO-manipulable index, and
> `endpoint.address` out of manifests written by strangers. On this host an SSRF
> that reaches the metadata endpoint is credential theft, not an internal port
> scan. The egress client is built first, for this reason.

> ### Decision 03 — Capabilities come from the published manifest. This service never asks the control plane.
> **2026-08-12.** Every capability we index is read from
> `/.well-known/agent-discovery.json` over HTTPS, from the site's own domain, by
> the same code for every site. There is no private ingest from `apps/server`,
> and there is no domain hint from it either.
>
> Three reasons, in order of how much they matter:
>
> 1. **The tolerant reader gets exercised on every ingest.** ADS is an open
>    spec; implementations in the wild will be nothing like ours. A reader that
>    only runs against rare third-party files is undertested and breaks the
>    first time it matters. Routing our own customers through it means it runs
>    constantly, against real files, for people we can call when it goes wrong.
> 2. **The published file is what every other agent sees.** Our database and
>    that URL can disagree. Indexing the database means indexing something no
>    one outside Cheela can observe.
> 3. **Publishing the file is the consent.** `cheela manifest pull` writes
>    `public/.well-known/agent-discovery.json`
>    (`packages/cli/src/bin.ts:10`), and shipping it is an affirmative public
>    act. A row in our database is not. This is why there is no dashboard
>    opt-in: the spec already has one.
>
> **Known cost, accepted:** a Cheela customer's capabilities appear only once
> their domain turns up in a result set, is reached by the DNS sweep, or is
> submitted. That is slower than an internal feed would be. In exchange the
> capability index is built entirely from public, observable data — anyone could
> rebuild it from scratch, and there is no mechanism by which it could favour
> our own customers.
>
> **Build no internal ingest API.** The earlier design listed "first-party
> registry — Cheela's own deployed runtimes, ingested over an internal API" as
> one of four ways manifests are found. That source is dropped. Its reasoning
> still stands on its own terms — those runtimes *are* schema-valid by
> construction and brokered by us — and it is overruled anyway, because a second
> ingest path is a second reader, and the second reader is the one that never
> gets tested. Recorded rather than simply omitted, because it is the obvious
> thing to propose again.

---

## The contract is already written

`src/shared/events.ts` is the wire format, and `apps/search-web` consumes it
today against its own fixture corpus. That ordering was deliberate: the surface
exists, so every step below has a working consumer to be tested against rather
than a mock.

Two properties are load-bearing and neither is negotiable during
implementation:

1. **Sources and capability events are emitted before the first answer block.**
   The capability lookup is a hash join on domains that have already arrived; it
   completes roughly two seconds before composition does. A pipeline that
   batches its output throws that away and the surface cannot get it back.
2. **`error` is a frame, not a status code.** A 500 tells the surface something
   failed; an error event tells the person what.

Contract changes go in this file first. A producer emitting something the
consumer has not learned to read is the recoverable direction; the reverse is a
blank screen.

---

## Phase 0 · Search — ~4 weeks

**A search engine that works. No ADS anywhere in it.** This is the MVP and it is
useful on its own.

### Build order

Numbered because the order is the argument. Each step's acceptance criterion is
the thing that has to be demonstrably true before the next one starts.

**0 · Deployable skeleton.** — *repo side done; GCP side pending.*
`Dockerfile`, Cloud Run service, a dedicated service account with the narrowest
roles that work, secrets in Secret Manager, deploy from the mirror.
→ *Accepts when:* `/health` answers on a Cloud Run URL, deployed by CI from
`cheela-search-api`, and the service account can read its secrets and nothing
else.
→ *Status:* **accepted, 2026-08-13.**
`https://search-api-utgemqbhxq-as.a.run.app/health` answers, built and deployed
by Cloud Build, running as `search-api@…` which holds no project roles beyond
`secretAccessor` on its three secrets and `cloudsql.client`. A real query
streams 17 events end to end — Tavily → 8 candidates → 4 extracted → ranked →
4 sources → composed.
→ *Cloud SQL `cheela-search`, reached over a unix socket*, so the instance has
no public IP allowlist and is unreachable from the internet. `/health` reports
`database: reachable` — reported rather than asserted, because a health check
that fails on a database blip turns it into a restart loop.
→ *Why first:* "it deploys" is the single most painful thing to retrofit, and
every step after this is easier to trust when you can ship it.

**1 · Egress client** — `src/infra/egress`. — *done.*
One client, one policy, every outbound request in both planes. Resolve DNS
first and reject RFC1918, loopback, link-local and `169.254.169.254`. Pin the
resolved IP so nothing can rebind between check and connect. Refuse cross-host
redirects. Cap response size and wall-clock time.
→ *Accepts when:* a test suite proves refusal of each of — metadata endpoint,
private ranges, loopback, link-local, a cross-host redirect chain, an oversized
body, a slow-loris body, and a hostname that resolves differently on the second
lookup.
→ *Status:* accepted. 82 tests in `test/egress/`, one per refusal above plus the
IPv6 spellings of loopback and the metadata address, the port and scheme rules,
and the ordinary case. Two controls were added beyond the criterion: a
scheme allowlist, because `file://` is a URL too, and an 80/443 port allowlist,
because a *public* host serving on 6379 is still Redis.
→ *Why second:* every remaining step makes outbound calls. Build fetch-and-
extract first and the policy gets bolted on afterwards with one path missed.
Two implementations means one of them is wrong.

**2 · Storage** — `src/infra/db`, migrations. — *done.*
Postgres 16 with pgvector, `web` schema. `query_log` lands here, in this step,
permanent and unlinked from any user identity.
→ *Accepts when:* migrations run clean forward on an empty database and the
schema matches the tables below.
→ *Status:* accepted, against a real Postgres 16 with pgvector 0.8.6 —
`docker compose up -d postgres` now serves one, and `TEST_DATABASE_URL` points
the suite at it. Ten tests, including four concurrent runners racing a cold
start. Migrations are forward-only and run as their own process, not on boot:
migrating during a cold start turns a schema change into a latency change, and
a bad migration into an outage rather than a failed deploy step.
→ *Gap closed:* `ci.yml` now runs a `pgvector/pgvector:pg16` service container
and sets `TEST_DATABASE_URL`, so these run on every push rather than only on
somebody's laptop.

**3 · Upstream provider interface** — `src/infra/upstream`. — *code done; not accepted.*
**Two vendors, wired, switchable by config.** Not "designed for two" — two.
Normalize both to one candidate shape.
→ *Accepts when:* the same test suite passes against either vendor with only a
config change, and a forced failure of one falls through to the other.
→ *Vendors:* **Tavily** and **AnySearch**. Two others were ruled out, and both
look obvious from a distance, which is why they are recorded.
**Brave** — its free tier is behind a payment card that would not accept ours: a
mundane blocker and a total one.
**Google Programmable Search** — chosen next because it bills through a GCP
project that already had a working card, then dropped on 2026-08-13 when it
turned out no longer to offer whole-web search. It now covers only "a specified
collection of sites", so a general query returns almost nothing and looks like a
broken engine rather than a scoping limit. The API key created for it was
deleted; the provider code is kept, marked not-for-production, because it is a
working second implementation of the interface and is useful for site-restricted
search.
→ *SearXNG was considered and rejected.* It scrapes engines from a datacenter
IP, which Cloud Run's ranges get blocked from fastest; being an aggregator like
Tavily it is not really a second vendor; and running a scraper against sites
whose terms forbid it contradicts Decision 03's own argument about consent.
→ *Status:* **accepted, 25 tests.** The rotation is proven — failover on error,
no failover on an empty result set, abort stops the sweep, total failure
reported rather than thrown, identical behaviour whichever provider answers.
→ *Verified against the live APIs, not against documentation.* Tavily's real
response reconciles with what was implemented. AnySearch's shape was read off a
real call **before** its provider was written — deliberately, because the last
shape taken on trust was the egress client's `accept-encoding`, whose tests
passed against the same assumption they encoded. Two details that would have
been wrong if guessed: results nest under `data.results`, and both a `snippet`
and full page `content` come back, neither of which a `Candidate` has anywhere
to put.
→ *Failover proven end to end with real vendors*, by breaking the Tavily key and
watching the rotation fall through to AnySearch and answer. That is the
criterion, met with the real thing rather than a stub.
→ *Why both now:* a single search vendor is a single point of both cost and
termination, and the second one never gets added later, under pressure, when
the first one changes its pricing. Both have free tiers, so this costs the
interface and nothing else.

**4 · Fetch and extract** — `src/domain/retrieval/`. — *done, with one caveat.*
Top 6–10 candidates in parallel, through the egress client. Main-content
extraction, boilerplate stripped, hard per-URL timeout. A slow page is dropped,
never waited on.
→ *Accepts when:* extraction success rate is above 0.90 on a fixture set of
real pages, measured — not eyeballed. Silent extractor failures look exactly
like model failures downstream, and this is the only place they are cheap to
find.
→ *Status:* 27 tests. Readability over linkedom rather than jsdom — an order of
magnitude faster to parse, and this runs for ten pages inside a ~1.2s stage.
Every outcome is a usable extraction or a **named reason**
(`javascript-shell`, `no-main-content`, `too-short`, `not-html`,
`http-error`…), which is the whole point: a client-rendered shell that extracts
to `""` is indistinguishable downstream from a page that said nothing, and that
mistake costs a week of blaming the model.
→ *The caveat was right, and it caught a real bug.* The fixture set models page
shapes rather than being real pages, and a rate measured against fixtures
somebody designed to pass is weak evidence. Measured against the live web for
the first time on 2026-08-13, it scored **1 page in 8** where the fixtures
scored 8 in 8. Cause: the egress client advertised `accept-encoding` and undici's
`request()` does not decompress — unlike `fetch()` — so the extractor was handed
gzip. It failed *quietly and downstream*, reporting `no-main-content` on
ordinary articles, which reads as an extraction problem rather than a transport
one. Fixed; the same query now scores **0.63**.
→ *The 0.90 gate needs redefining before it can be met, and not by improving
extraction.* The remaining failures on that run were one client-rendered page
(reddit) and two 403s from bot detection (medium, stackoverflow). Those are
different in kind: a 403 is a site declining to be read by an identified bot,
and **we do not spoof a browser user agent to get around it** — that would
contradict Decision 03's argument about consent and the plan's own rule that we
crawl under a name an operator can block. So `extracted / requested` measures how
many sites block bots as much as it measures extraction. **Redefine the metric
over pages that did not refuse us**, and count refusals separately, before
treating 0.90 as reachable.

**R · Routing** — `src/domain/route/`. — *built 2026-08-13, ahead of its phase.*
Four intents, ambiguity resolving downward.
→ *Why early:* two of its payoffs need no capability index at all. A
navigational query answers in **184 ms** against ~8 s, with no upstream call, no
page fetches and no model — measured, not projected. And intent changes the
*answer shape*: "nike jordans" gets `ANSWER / OPTIONS / TRADEOFF` naming where
to buy, not a cited essay on the shoe's history. That second one is the half
people assume waits for Phase 1, and it does not.
→ *Two passes, because the budget is 90 ms and a model call is 300–800 ms.* A
structural pass runs synchronously and answers only "is this literally an
address" — the one intent that must be known before searching. Everything else
classifies **concurrently with the upstream call**, resolving inside its
500–1700 ms, so it costs nothing on the critical path.
→ *`action` is never returned*, even when a query plainly asks for one. There is
no invoker yet, and a route to a capability that cannot be called is a route to
a dead end. Phase 2 changes one line.
→ *A cheaper model than the composer's* — `gemini-2.5-flash-lite` against
`2.5-flash`. Routing picks one of three words on every query; composition writes
the answer once. This is the first stage to use the per-stage model pin the seam
was built for.

**5 · Chunk, embed, rerank** — `src/domain/retrieval/`. — *chunk and rank done; embed deferred.*
Keep ~12 passages.
→ *Accepts when:* recall on the labeled set clears the bar, and the numbers are
per-stage rather than end-to-end.
→ *Status:* 23 tests. Chunking splits on the block boundaries extraction
preserves, keeps paragraphs whole, overlaps so a claim on a boundary survives
in one chunk, and splits code on lines rather than sentences. Ranking is BM25
over the passages retrieved for this one query, behind a `Ranker` seam.
→ **The embedding stage is deliberately absent, not forgotten.** This plan's own
argument is that every stage has a plausible-sounding improvement that makes
end-to-end quality worse, and that without per-stage measurement you ship all of
them and cannot tell which did the damage. BM25 here is not lexical retrieval
over a global index where it would miss everything phrased differently — it is a
hundred passages from pages an upstream engine already judged relevant. Semantic
ranking earns its model call per query on the request path or it does not, and
**the eval harness is what says which.** Adding it first would be exactly the
mistake the plan warns about.
→ *Not accepted:* the criterion is recall on the labelled set, and that set does
not exist. What is asserted instead is behaviour that must hold whatever the
numbers say — distinctive terms beat common ones, no single page owns the whole
context, and the shortfall from capping is filled rather than returned thin.

**6 · Compose and stream** — `src/domain/compose`, `src/domain/pipeline.ts`. — *code done; not accepted.*
Citation per claim. Emit blocks as they are produced.
→ *Accepts when:* `apps/search-web` renders a real streamed answer against this
service with its fixture corpus disabled. That is the integration test — the
consumer already exists, so use it.
→ *Status:* 26 tests. `/search` now runs the pipeline for real. The ordering the
contract depends on is asserted directly: **every source event precedes the
first answer block**, because the surface builds its rail while the answer is
still composing and a batched pipeline throws that away.
→ *Two composers behind one interface.* The LLM composer goes through
`@cheela/provider`, and is fully tested against a stub `Provider` — no key
needed, because what is being tested is the prompt this stage builds and the
parsing of what comes back, both deterministic. What a real model *says* is the
eval harness's question.
→ *The extractive composer is the fallback and is not a placeholder.* With no
model configured it quotes the best passages verbatim, attributed, and says in
the answer block that it is doing so. Nothing paraphrases, so nothing can
misreport a source. A degraded answer beats an error on a query the retrieval
stages answered perfectly well — and it is what makes the pipeline
demonstrable without a model key at all.
→ *Injection containment is structural, not wording.* The composer has no
tools and cannot invoke anything; passages arrive fenced and labelled as data;
retrieval and action never share a context. A test asserts the request carries
no capabilities.
→ *Invented citations are dropped, and the claim is kept.* A chip that opens
nothing is worse than no chip — an uncited sentence reads as unsupported, a
broken citation reads as supported.
→ **Not accepted:** the criterion is the surface rendering against this service,
which needs an upstream vendor key. `test/pipeline.test.ts` is as close as it
gets without one — a stub upstream, a fixture server serving real HTML, and
every stage between running production code.

**7 · The three caches, plus the log.**
→ *Accepts when:* hit rate is on a dashboard, from the first day it can be.

**Parallel track — the eval harness.** The 200 labeled queries are a writing
task, not a coding one; start them at step 0. The harness code lands at step 2.
Every stage here has a plausible-sounding improvement that makes end-to-end
quality worse — a better embedding model that loses proper nouns, a cheaper
extractor that drops the answer. Without per-stage measurement you will ship all
of them and be unable to tell which one did the damage.

### The three caches, and the log

| Object | Key | Lifetime | Why |
|---|---|---|---|
| Query cache | normalized query + provider | Short TTL | Rankings move |
| Content cache | canonical URL | Long, revalidated | Pages mostly do not |
| Embedding cache | `(content_hash, model_version)` | Permanent | Embedding the same paragraph twice is pure waste |
| **Query log** | — | **Permanent, never expires** | The seed corpus for Decision 01 |

The content cache is the strategic one: it fills along the shape of real
traffic, so head queries go warm quickly and the upstream bill flattens against
volume rather than tracking it.

**Cache hit rate decides unit economics outright at MVP** — the dominant cost
per query is upstream API calls and page fetches, not model tokens and not
vector search. Instrument it before optimizing retrieval quality, not after.

**The query log is not the query cache.** Storing them as one object with one
TTL throws away the asset. And because queries are sensitive — health, legal,
financial, personal — the log is stored unlinked from any user identity,
normalized, with a retention policy written before the first row lands. Cheap
now, expensive to retrofit against a year of logs.

### Gate out of Phase 0

| Metric | Bar |
|---|---|
| Answer correctness (judge + weekly human spot-check) | > 0.80 |
| Citation faithfulness — does the cited passage support the claim | > 0.95 |
| Extraction success rate | > 0.90 |
| Content cache hit rate | > 0.55 |

If the search engine is not good, no action layer rescues it.

---

## Phase 1 · Discovery — ~3 weeks

**Results that know what a site can do.** The capability index joins to results
by domain. Nothing is invoked; this phase is pure information gain and carries
no execution risk.

### Where manifests come from

Three sources, and per Decision 03 the control plane is not among them.

| Source | Cost | Notes |
|---|---|---|
| **Opportunistic, from traffic** | One GET per domain, ~1 KB | Every domain in a result set is queued for a probe. Weighted by what people actually search for, which beats any static ranking list |
| **DNS `TXT` sweep** at `_agent-discovery.<domain>` | Cheaper than the GET | Wide coverage the traffic stream will not reach for months |
| **Submission** | Free | Low volume, high intent, and it doubles as the domain-verification funnel — and it is the fast path for a Cheela customer, the same fast path anyone gets |

All of it runs in the crawler, as a scheduled Cloud Run Job. **None of it runs
on the request path.** A manifest fetched during a query would blow the 60 ms
capability-lookup budget and the "chips visible before the answer" argument with
it. Fetched out of band; read from the index at query time as a hash join on
domain.

### Reading a spec written by strangers

The reader is built on the Ajv instance and vendored schema already in
`@cheela/adp`, depended on by published semver range the way `apps/server` does
it — not `workspace:`, which cannot resolve in the mirror.

- **An unrecognized `transport` or `auth` does not remove a capability from the
  index.** We cannot call it, but the site still does this and the user should
  still be told. Not-invocable-by-us is a property of the result, not a reason
  to hide it.
- **Round-trip unknown fields and `extensions` verbatim.** A field dropped today
  is a feature that cannot ship tomorrow without a full re-crawl.
- **`description`, `inputSchema` and `outputSchema` are all optional.** Handle
  the degenerate case first — a name, a version and an endpoint — because it
  will be common in hand-written manifests.
- **Never assume our own shape.** `endpoint.address` is any non-empty string.
  `invocationName` may be absent; derive it by the spec's rule, not ours. Do not
  expect Cheela's broker URL pattern and do not treat its absence as a defect.
- **A major `specVersion` ahead of ours stops the read.**
- **`404` is the normal outcome and never an alert.** Recheck in 30 days.
  Conditional requests — ETag and Last-Modified — on every re-fetch.

### Enrichment

Generate 8–15 intent phrases per capability and embed each one. **Never embed
the identifier.** `com.example.lookupOrder` is a poor retrieval target for
"where's my package", and no amount of embedding-model shopping closes that gap.
Retrieval matches a phrase and resolves to its capability, max-pooled. One call
per capability per content-hash change.

Enrichment also derives the effects tier, an argument profile, an injection
verdict on the free text, and a canonical summary so the UI never renders
operator-written prose verbatim.

> **Invariant.** Manifest text can only *lower* a capability's privilege, never
> raise it. The effects tier is ours, derived from structure — the verb in the
> name, the shape of the schemas, the endpoint. If a manifest describes
> `deleteAllRecords` as "safely previews your data", our verdict stands and the
> mismatch is itself a demotion signal.

**Gate:** capability recall@50 > 0.92, and chips visibly ahead of the answer in
the streamed response — which the surface will show you directly.

Phase 1 also measures the thing the product bets on: chips render and nothing is
invoked, so click-through tells you the real demand for actions before the
invoker exists. That measurement is the actual purpose of this phase.

---

## Phase 2 · Action — ~3 weeks

**Read-only calls, narrowest possible surface.** Transport we speak, auth we can
satisfy, domain verified, `read` tier, schema present.

- Planner and binder, with **Ajv pre-validation against the declared
  `inputSchema` before any network call, always, including at `read` tier.**
- A validation failure is **a UI state, not an error**: a required argument is
  missing, so render the card with a field for it and stop.
- No `inputSchema` at all is permitted and common. Unvalidatable input is
  `unknown` effects tier by definition and cannot be auto-invoked.
- Budgets: max 3 invocations per query, max 1 provider unless the query names
  several, hard wall-clock ceiling per stage, per-provider circuit breaker,
  results cached on `(capability_id, canonical_input_hash)`.
- **Retrieval and action must not share a context window.** This is the
  structural defense against injection from page content, and it is why
  composition happens after invocation rather than around it. Nothing retrieved
  may influence the planner's policy or the gate.

> **Invoking someone's capability spends their money.**
> `apps/server/src/domain/capability/invoke-capability.ts` meters a broker call
> against the *runtime owner*. Identified user agent, robots honored, opt-out
> via a manifest extension, never invoke during crawl, and an operator-facing
> log of every call we made and why.

**Gate:** zero ungated invocations across the full eval suite plus a red-team
pass. This one does not negotiate.

---

## Phase 3 · Consent — not in scope

Writes and third-party credentials. Design the effects tier and the gate to
accommodate it now; build none of it until Phase 2 has run in production for a
quarter. It is a compliance project wearing an engineering costume.

---

## Storage

Postgres 16 with pgvector. Two schemas, one instance — `web` and `capability` —
split so the web side can move out later without touching the capability side.
`docker-compose.yml` already runs Postgres 16 for SuperTokens, so local dev
costs one more database on a container that is already there.

Not the control plane's Mongo, for any of it. Different blast radius, different
backup needs, different scaling curve; a bad crawl must not be able to reach
billing.

```sql
-- ─── web plane ───
documents      (url, canonical_url, domain, title, extracted_text,
                content_hash, fetched_at, etag, expires_at, http_status)
passages       (id, document_id, ordinal, text, content_hash,
                embedding vector(1024), model_version)   -- HNSW, cosine
query_cache    (query_hash, normalized_query, provider, result_urls[],
                fetched_at, expires_at)
query_log      (id, normalized_query, occurred_at, result_domains[])
                -- permanent; no user id, no session id, no address

-- ─── capability plane ───
sites          (domain, discovery_method, robots_state, adp_state,
                domain_verified_at, trust_score, next_probe_at)
                -- `domain` is the join key to documents.domain
manifests      (id, site_id, url, raw_json, content_hash, spec_version,
                fetched_at, etag, valid, validation_errors,
                signature_state, unknown_fields)   -- kept, never dropped
capabilities   (id, manifest_id, provider_id, name, invocation_name, version,
                description, input_schema, output_schema,
                transport, auth, address, extensions, deprecated,
                invocable_by_us, content_hash, tsv tsvector)
enrichment     (capability_id, summary, intent_phrases[], effects_tier,
                arg_profile, injection_verdict, model_version, enriched_at)
phrase_vectors (capability_id, phrase, embedding vector(1024), model_version)
invocations    (id, capability_id, query_id, input_hash, status, latency_ms,
                output_conforms_to_schema, cached_until)
```

**The whole cross-plane integration is `documents.domain → sites.domain`.** Keep
it that way. Every temptation to make the join smarter buys marginal precision
and costs the property that either plane can be rebuilt, replaced or emptied
without the other noticing.

Resist a dedicated vector store on the capability side specifically: those
queries need lexical matching on provider names, dense matching on phrases, and
structured predicates on transport, auth, effects tier and trust *in one
statement*. A vector database makes the predicates a post-filter, which wrecks
recall exactly when the filter is selective — and here it always will be.

---

## Configuration

`src/shared/config.ts` parses once at import and freezes. Nothing is required
yet — that is Phase 0 not having started, not a decision. **Each variable
arrives as a required field at the same time as the code that reads it.** A
variable made optional so the service can boot without it is a variable that
will be missing in production.

| Step | Adds |
|---|---|
| now | `PORT`, `LOG_LEVEL`, `ALLOWED_ORIGINS`, `NODE_ENV` |
| 1 | egress timeout, max body size, DNS resolver pin |
| 2 | `DATABASE_URL` |
| 3 | two upstream provider keys, provider order |
| 5 | embedding + rerank model pins |
| 6 | composer model pin |
| Phase 1 | enrichment model pin, crawler ingest token |
| Phase 2 | broker base URL, per-provider budget ceilings |

For the LLM stages, keep a seam that lets a different model be pinned per stage
— routing, reranking, planning and composition have genuinely different cost and
latency profiles and you will want to change your mind about all four.

**That seam is `src/infra/model`, not `@cheela/provider`, and this overrules an
earlier line in this plan.** Every provider in that package calls
`assertHasCapabilities`, which refuses a request carrying no tools. Its reasoning
is sound for what it is for: an agent runtime with an empty tool list is a plain
chat completion wearing an assistant's clothes, and it fails silently. But
**composition is not an agent runtime, and its having no tools is a security
property** — the structural half of the injection containment, asserted by a
test. Registering a dummy capability to satisfy that check would hand a model
reading untrusted page content something to call, which is the exact thing the
design forbids.

So the model call goes through the egress client instead, which is a consequence
worth having rather than a compromise: "one client, one policy" now covers the
LLM call too, with the same deadline, size cap and address rules as a page
fetch.

---

## Testing

`test/app.test.ts` asserts the **wire encoding**, not the types.
`src/shared/events.ts` is duplicated in `apps/search-web` — both apps build
standalone from their own mirrors, so TypeScript cannot catch a drift between
them. A test on the bytes can.

The egress client gets an adversarial suite, not a happy-path one. See step 1.

**Ungated invocations is a release blocker at any value above zero.** It is not
a quality metric and it does not get traded against anything.

---

## Open questions

- **Which two upstream providers.** The interface is fixed by step 3; the
  vendors are not. Pick on cost per thousand queries and on termination risk,
  not on snippet quality — we do not use their snippets.
- **Whether the crawler is a second app or a second Cloud Run Job here.**
  Separate app is the stated position and the reasoning above stands, but it
  costs a second deploy target and a second mirror. Worth re-arguing once
  Phase 1 has a real crawl volume to reason about.
- **Vertical.** "As good as the others, plus buttons" is not a reason to switch
  search engines. The mitigation is to pick a vertical where actions are the
  point — commerce, travel, support, local services — and be the best engine in
  it. Not decided, and Phase 1's click-through data is what should decide it.

### Answered

- ~~Where this deploys~~ → Decision 02, Cloud Run.
- ~~Whether to own the index~~ → Decision 01, deferred; query log is the path back.
- ~~How manifests are found~~ → Decision 03, published file only, no control-plane path.
