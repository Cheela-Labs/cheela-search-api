# apps/search-api — build plan

**Status:** Phase 0 — deployed; steps 0–6 accepted (6 on 2026-08-15); step 5 accepted 2026-08-15; step 7 dashboard built, accepts on its first production traffic · Phase 1 — first slice built 2026-08-15 · **Scope:** Phase 0 through Phase 2
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

**3b · Fan-out, and two free specialists.** — *built 2026-08-15.*
`src/infra/upstream/fanout.ts`, `wikipedia.ts`, `github.ts`.

→ **This overrules step 3's own argument against fan-out, and the argument was
half right.** `createRotation` says asking both vendors "would double the bill
to merge two rankings we have no principled way to merge — and the pipeline
re-ranks over fetched passages anyway, so a second opinion about ordering buys
nothing." The ordering half stands. What it missed is that fan-out does not
mainly buy an opinion about *order*; it buys a different **candidate set**. Two
vendors disagree about which ten pages exist far more than they disagree about
how to sort them, and **a page that is never fetched cannot be reranked into
the answer.**

→ *Round-robin is the whole merge policy, and that is not laziness.* Scores
from two vendors are not comparable — one provider's 0.9 and another's 0.9
answer different questions, and normalising them invents an agreement that does
not exist. Position is comparable: each provider's first result is its own best
guess. So `interleaveAll` takes one from each in turn and the reranker settles
quality later, over text we fetched and read ourselves — the only comparison in
this pipeline grounded in something we verified.

→ *`SEARCH_PROVIDER_MODE` defaults to `rotate`, because the default must not be
the expensive one.* Fan-out multiplies the dominant cost line by the number of
paid vendors on every query, including all the ones the first vendor would have
answered perfectly. Low traffic is a reason to *choose* it deliberately, not a
reason to ship it as what happens when nobody decides.

→ **The specialists are a different argument entirely: they are free, so they
never had to justify themselves against the query.** Wikipedia needs no
credential and has never once refused us — worth stating next to a corpus where
41% of retrieval failures are sites declining to serve an identified bot. On an
informational query it contributes a page that will actually extract, which
beats a page that ranks better and returns 403. GitHub reaches the README,
which is what actually answers `pgvector hnsw index parameters`.

→ *They are additive within a small ceiling, not competitors for the same
slots.* Merging specialists into a fixed budget would mean every Wikipedia
result displacing a general one — strictly worse on `nike jordans`, where an
encyclopedia article about the shoe would crowd out the shops that sell it, and
the specialist has no way to know the query was not for it. Three extra pages
on a stage that already fetches six at a time is at most one more wave.

→ *And they are kept out of `SEARCH_PROVIDER_ORDER` deliberately.* A rotation
that failed over from Tavily to Wikipedia would answer `cheap flights to goa`
with an encyclopedia article and call it a successful search. They are not
interchangeable with a general vendor and one list invites treating them as
though they were.

→ **GitHub is token-gated, and unauthenticated is worse than absent.** 10
requests per minute is exhausted by one Cloud Run instance in about six seconds
of ordinary traffic, after which it contributes nothing but `rate-limited`
entries — which would make an *extraction* metric look like an extraction
problem. A token with no scopes raises it to 30.

→ *One case where a specialist changes the verdict:* if every paid vendor
failed and a specialist answered, the result is theirs rather than an error
frame. A degraded answer from Wikipedia beats "no search provider answered" on
a query we can in fact still answer.

→ *The suite sets `SEARCH_SUPPLEMENTS=""`, and that line is load-bearing.*
Wikipedia needing no credential means it is built whenever it is listed — so
the process-wide `upstream` would reach the real en.wikipedia.org from any test
using default dependencies. This was found by a test that started passing for
the wrong reason: `app.test.ts` asserts that a failed search is an error
*frame*, and it stopped failing because Wikipedia answered.

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
→ **Latency note, 2026-08-15: the slow half of the tail is a page that never
answers, not work we are doing.** Across the 26-query set the median query took
~7 s and the slowest took 15–18 s — and the slow ones include
`what is the largest planet in the solar system`, which is not a hard question.
`timeout` and `rate-limited` are 8% of retrieval failures, and unlike a `403`
they are paid for in wall-clock *before* they fail: the deadline lives per
request in the egress client, the read stage runs six at a time, and one dead
URL in the last wave holds the stage open for its full timeout while
contributing nothing. A `403` costs a round trip; a timeout costs the budget.
→ *So the cheapest latency work here is not a faster extractor.* It is
declining to wait the full deadline for the last page or two once enough have
answered — which is step 4's own rule, "a slow page is dropped, never waited
on", applied to the stage as well as to the page. Not built, and deliberately
recorded rather than done alongside step 5: it changes what reaches the
composer, so it needs its own before-and-after on the harness.

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
→ **Freshness, added 2026-08-15.** The router now also says whether a query's
answer changes within days, and a `high` verdict forces the content cache to
revalidate. The cache holds a page for **seven days**, which is right for almost
everything and is a *wrong answer with a good response time* for the small class
of queries that move — `current node.js lts version` is in the eval set for
exactly this, and a seven-day-old copy of a release page does not look stale, it
looks like an answer.
→ *Revalidation, not bypass, and the distinction is the entire cost argument.*
Skipping the cache would re-download and re-extract every page on every volatile
query. Forcing the conditional request instead means an unchanged page answers
`304` — one round trip, no body, no extraction, no re-chunking — so correctness
on these queries costs a round trip rather than a re-read, and only a page that
genuinely changed pays the full fetch. Which is precisely when it is worth
paying.
→ *Two values, `high` and `normal`, because the action it drives is binary.* A
`medium` tier would have to be mapped onto one of these two anyway, at which
point the mapping is the real policy and the third name only hides where it
lives.
→ *The marker is parsed as a field, not a position.* The prompt asks for
`intent | rewrite | fresh` and models reliably emit two fields, sometimes
reversed. Reading by position gives an informational query a retrieval query of
`"fresh"` — which the pipeline would then search for, and which looks like a bad
index rather than a bad parse.
→ *A cheaper model than the composer's* — `gemini-2.5-flash-lite` against
`2.5-flash`. Routing picks one of three words on every query; composition writes
the answer once. This is the first stage to use the per-stage model pin the seam
was built for.
→ **The label alone did nothing, and that was measurable.** Classifying "nike
jordans" as discovery and then searching for "nike jordans" retrieved
Wikipedia's Air Jordan article and a sneaker blog — the verdict was correct and
changed no result, because the index was asked the same question either way. So
the router now returns a **rewritten retrieval query** alongside the intent
("buy nike jordan sneakers online store"), and discovery runs a second upstream
search with it. Chained off the classifier rather than sequenced after the first
search, so it overlaps the search already in flight instead of following it; the
merged candidate list is interleaved and capped at `limit + 4`. Result on that
query: 2 sources → 9 destinations, including nike.com, finishline, jdsports and
flightclub.
→ **Open, found 2026-08-15: a schemeless URL with a path does not shortcut, and
routing accuracy cannot see it.** `npmjs.com/package/hono` took **5.5 s and a
full pipeline** where `github.com` took 1 ms. `routeStructurally` handles a
bare hostname and a URL carrying a scheme; this is neither, so `HOSTNAME` fails
on the `/package/hono` and it falls through to the ordinary path
(`src/domain/route/structural.ts:61`).
→ *The instructive half is that the metric read 100%.* The model classifier
then returned `navigational` — correctly — so routing accuracy counted it right
while the query cost eight page fetches and a model call. **The metric measures
the verdict; the shortcut keys off the structural pass**, and nothing yet
measures whether a navigational query actually skipped retrieval. A latency
assertion per intent would have caught this and a label check never will.

**W · Where to go** — `places` events. — *built 2026-08-13, with routing.*
Destinations for discovery queries: a link, a host, a title and the page's own
`og:image`.
→ *Why this is not the source rail with pictures.* A `Source` is evidence and
carries passages a citation can point at. On a discovery query the pages most
worth showing are precisely the ones that **cannot be read** — storefronts
render their catalogues in JavaScript, so they extract to nothing. Eight of
twelve pages retrieved for "nike jordans" failed extraction. Built from sources,
this row would be empty on exactly the queries it exists for.
→ *The head survives what the body does not.* A JavaScript shell still ships a
complete `<head>`, so `extract()` now returns a `preview` on every failure path
after parsing. Nothing about those pages is ever cited and nothing claims they
said anything; they are destinations, which is a weaker claim and an honest one.
→ *Images are the page's own `og:image`, never a matched one.* Search providers
return a bag of query-matched images next to their results, and pairing image
*n* with result *n* yields a beautiful grid asserting a relationship that does
not exist — measured on a live "nike jordans buy india" query, four of five
returned images were hosted by a retailer absent from the results. Taking the
image from the page the card links to makes the pairing true by construction.
→ *There are no prices, and there will not be until something can read one.*
Sixteen live results across three shopping queries carried zero `Product`
offers: what a search engine returns for a shopping query is storefront and
category pages, not product pages. A card asserting a price it had not read
would be inventing the one number a reader most needs to trust.
→ *What is not reachable, and why we are not fixing it that way.* Of the
retailers named in the original request, ajio 403s, myntra times out, nike.com
cross-host-redirects to nike.in, and amazon.in's search page carries neither
JSON-LD nor `og:image`. Spoofing a browser user agent would get past most of
that and is refused for the same reason as in step 4 above. Amazon.in *does*
appear with an image on queries where the upstream returns a category page.

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
→ *What is asserted in tests* is behaviour that must hold whatever the numbers
say — distinctive terms beat common ones, no single page owns the whole
context, and the shortfall from capping is filled rather than returned thin.
→ *Status:* **accepted, 2026-08-15.** The criterion was "recall on the labelled
set clears the bar, and the numbers are per-stage rather than end-to-end", and
the blocker was that the set did not exist. It does now: `mustRetrieve` in
`eval/queries.jsonl` labels the *facts* a correct answer has to have found, and
the harness checks each one at three points — the fetched pages, the passages
that survived ranking, the answer itself — so a missing fact names the stage
that lost it instead of the symptom.

| | value | n |
|---|---|---|
| passage recall | **90.0%** | 20 queries |
| **lost by ranking** | **3.3%** | 30 facts that reached the pool |

→ *The bar this plan never wrote down is written down now:* **passage recall
> 0.85**. Set here rather than back-dated, and set where it is because the two
buckets below say the remaining loss is not retrieval's to fix.

→ **The embedding stage stays deferred, and now on evidence rather than on
argument.** Of 31 labelled facts, 30 were fetched, and 29 of those survived into
the composer's context. **BM25 dropped exactly one.** That single fact is the
entire headroom a semantic reranker could buy, and buying it costs a model call
per query on the request path, forever, on every query including the 29 that
did not need it. Step 5's own position was that semantic ranking "earns its
model call per query on the request path or it does not, and the eval harness
is what says which." It says no. Revisit if the number moves, not on taste.

→ *Where the facts went, which is the more useful half:*

| bucket | n | whose |
|---|---|---|
| `answered` | 27 | — |
| `composition` | 2 | a passage carried it; the answer did not use it |
| `ranking` | 1 | the ranker or the chunker dropped it |
| `retrieval` | 1 | never fetched, or extraction lost it |

**Composition loses twice what ranking does.** Small n, and a clear direction:
the next quality work is not in retrieval. It is the same finding as the
"Australian wildfire" answer that would not lead with Black Summer, which this
plan called "a retrieval problem wearing a composition problem's clothes" — and
on this measurement it is the other way round.

**5b · Document signals — title match and recency.** — *built 2026-08-15.*
`applySignals` in `src/domain/retrieval/rank.ts`.

→ *Kept out of the `Ranker` seam on purpose.* A ranker answers one question —
how well does this passage match this query — and every future implementation
of that seam would otherwise have to reimplement title and recency handling.
They are the same two multipliers whatever produced the base score.

→ **Multiplicative, because BM25 scores have no fixed scale.** A score depends
on the query's IDF profile, so the same additive bonus is decisive on one query
and invisible on the next. A multiplier means "worth half again as much"
regardless of magnitude, which is a claim somebody can argue with.

→ **A zero score stays zero, and that is the load-bearing property.** A passage
containing none of the query's terms scores 0, and 0 times any multiplier is 0
— so a recent date cannot float a passage that is not about the query. That is
precisely the failure people mean when they say freshness ranking made results
worse, and here it is structural rather than tuned.

→ **Absence of a date is never a penalty.** Most of the web declares no date, so
a signal that punished silence would be ranking on whether a CMS emits Open
Graph tags. Recency may only ever *promote* a page that proved it is recent.
The natural-looking alternative — defaulting an unknown date to `now()` — would
have made every uncached page the freshest thing in the result set.

→ *Recency applies only when the router said `fresh`.* On an ordinary query the
multiplier is exactly 1 and the stage does nothing, which is the point: a date
is allowed to reorder results only when the query said dates matter.

→ *The signals apply within the lexical shortlist, never the whole pool.* A
passage BM25 placed outside the top forty-eight is not one a matching title
should rescue — these break ties among passages already judged relevant, and
letting them reach further would make the `<title>` tag a retrieval mechanism.

→ *Modified time beats published time*, because the question is "how current is
this content", not "when did this URL first exist". A release-notes page written
in 2009 and updated last week is current, and ranking it as sixteen years old is
the exact failure the signal exists to prevent.

→ *Placeholder dates are discarded rather than believed.* A great many pages
emit `0001-01-01` or a Unix zero for "unset"; accepting one hands the ranker a
document that is confidently ancient rather than one whose date is unknown.
Those are different things and only one of them is true.

→ *`published_at` is stored, in migration 0005, and that is the third time this
table has needed it.* Extraction only runs on a cache **miss**, so a
column-less version would rank correctly against a cold cache and lose the
signal entirely as the cache warmed — the shape this plan already called "the
worst kind of bug, because it improves as the cache gets colder", after `image`
and after the query cache's titles.

**6 · Compose and stream** — `src/domain/compose`, `src/domain/pipeline.ts`. — *accepted, 2026-08-15.*
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
→ *Status:* **accepted, 2026-08-15**, against the criterion as written —
`search.cheelalabs.com` rendering a streamed answer from
`search-api.cheelalabs.com` with the fixture corpus disabled.

What the live stream shows, for a query with no fixture behind it:

```
stage(search) → intent(informational) → crawled(8) → stage(search,done)
→ stage(read) → stage(read,done) → source ×6 → stage(compose)
→ block ×3 → stage(compose,done) → done
```

**The ordering the contract depends on holds in production**, not only in
`test/pipeline.test.ts`: the last `source` event is index 11 and the first
`block` is index 13, so the surface has its whole rail before a word of the
answer arrives. The blocks carry interleaved `{"kind":"cite","n":N}` spans
rather than trailing footnotes, which is citation-per-claim as specified — and
confirms the LLM composer ran rather than the extractive fallback.

**7 · The three caches, plus the log.** — *code done; not accepted.*
→ *Accepts when:* hit rate is on a dashboard, from the first day it can be.
→ *Status:* 26 tests — 14 against fakes for the seams, 12 against a real
Postgres for the SQL. Two of the three caches are built; the embedding cache is
deferred with the embedding stage it exists for.

**The tables were there since 0001 and nothing had ever read or written them.**
Every query re-called the vendor and re-fetched every page: the identical query
twice, back to back against production, cost 6.3s and then 5.2s. That is the
gap this step closes.

| Object | Where | Key | Lifetime |
|---|---|---|---|
| Content cache | `web.documents` | canonical URL, or the URL asked for | 7 days, then revalidated |
| Query cache | `web.query_cache` | normalised query + provider | 10 minutes |
| Query log | `web.query_log` | — | permanent |

→ **Every cache is optional and degrades to a miss.** The stores swallow their
own errors, the pipeline takes them as optional dependencies, and a search with
no database runs exactly as it did before this step. A cache that can take the
service down when Postgres is slow is worse than no cache.

→ *Revalidation is counted apart from a hit.* A `304` still costs a round trip
but no bandwidth, no extraction and no re-chunking. Folding it into hits would
overstate the saving; folding it into misses would understate it against the
>0.55 gate.

→ **Three things would have failed silently, and each is now a test.** The
`documents` table had no `image` column, so a cache hit would have dropped the
og:image that discovery answers render — the feature would work cold and
degrade as the cache warmed. The `query_cache` stored URLs but not titles, and
`pipeline.ts` resolves a source title as
`extraction.title ?? candidate.title ?? domain`, so hits would have quietly
fallen back to bare hostnames. And a null title round-tripped through
`text[]` as `""`, which `??` does not treat as absent — that one renders a
blank title rather than a domain.

→ **The migrate step earned itself on its first run.** `src/migrate.ts`
imported `shared/config`, which validates the *service's* environment — so
applying a schema change refused to start with `TAVILY_API_KEY: no upstream
search provider is configured`. The job is given `DATABASE_URL` and nothing
else, correctly: a migration needs a database, not a search vendor. It reads
that one variable directly now. Handing the job every runtime secret would have
been the wrong fix twice — it widens what a schema change can reach, and it
makes any new required variable silently break migrations until somebody
remembers the job.

→ *Status:* **the dashboard exists**, as code, in `monitoring/` — a log-based
metric and four widgets, applied by `monitoring/apply.sh` and live in the
project. The content-cache scorecard carries the **>0.55 gate as a threshold on
the widget**, so it says whether the gate is met rather than leaving that to
somebody's memory.

→ **`/health` could never have been the number, and that is what was blocking
this.** Its counters live in the process, so they reset every time an instance
is replaced — and a service that scales to zero spends most of its life having
just forgotten everything it knew. So the process now emits one structured line
per cache decision and Cloud Monitoring counts them. That is this plan's own
position — "the sum across instances is the number that matters and that is the
collector's job" — carried one step further, because the *counting* is the
collector's job too. The counters stay for a local read and for the tests, no
longer pretending to be the metric.

→ *Three alternatives were rejected and are recorded because each looks
obvious.* A **periodic flush** of the totals is cheaper in log volume and wrong
on this host: Cloud Run throttles CPU to near zero between requests, so a timer
is not guaranteed to fire and the last interval before an instance dies is
lost. A **per-query summary line** is eight times less volume and needs a
request-scoped counter threaded through both the fetch stage and the upstream
rotation to buy a ratio that comes out identical. A **counters table in
Postgres** buys durability by adding a write to the exact path the cache exists
to make cheaper.

→ *The line names no query, no URL and no caller* — the property that lets
`/health` sit outside the token gate, kept true on the way out, and asserted as
an exact key set in `test/cache.test.ts` so that adding a field has to be
somebody's deliberate decision. The field names are also a contract with
`monitoring/cache-lookup-metric.yaml` that TypeScript cannot check, since the
other end is a YAML file in another system: rename one and nothing fails, the
metric simply matches nothing and the dashboard reports a confident, empty
zero. That is why it is a test and not a comment.

→ *Not yet accepted, and only one thing is missing:* a log-based metric does not
backfill, so the dashboard counts nothing until the deploy that starts emitting
the lines. **Accepts when it shows a real hit rate from production traffic.**

**Parallel track — the eval harness.** — *harness done 2026-08-15; the query
set is 26 of 200.* `scripts/eval.ts`, `scripts/judge.ts`, `eval/queries.jsonl`.
The 200 labeled queries are a writing task, not a coding one; start them at
step 0. The harness code lands at step 2.

*The 16 added on 2026-08-15 were written for step 5 specifically*, not as
general progress toward 200: its criterion needs facts with exactly one
spelling, on queries whose pages are certain to exist, so that a fact which
never reaches a passage was demonstrably lost by chunking or ranking rather
than by coverage. A set grown for one stage's question is worth more than the
same count grown at random.

**Every label is optional except the query**, so a half-labelled set still
measures something and each metric reports the `n` it was computed over. A
metric over four queries says `n=4` rather than speaking for the set. That is
what makes filling the set in incrementally worth doing rather than a
prerequisite.

**Two findings on the first full run, both real:**

**Measured after 3b/5b/freshness landed, 2026-08-15**, over two consecutive
runs of the same 26 queries — the second after the routing prompt was fixed.
Both are reported because the pair is the finding.

| Metric | before | run A | run B |
|---|---|---|---|
| routing accuracy | 100% | 96.0% | **100%** |
| extraction, addressable | 66.9% (n=163) | 76.1% (n=222) | **76.0%** (n=225) |
| domain recall | 50% | 100% | **100%** |
| passage recall | 90.0% | 100% | **95.0%** |
| lost by ranking | 3.3% (n=30) | 0.0% (n=31) | **3.2%** (n=31) |

→ **The ranking numbers move by one fact between identical runs, so neither
0.0% nor 3.2% is a real number.** The web is not a fixed corpus: the upstream
returns a slightly different set each time, and at n=31 facts a single page
swings the rate by three points. The honest reading is that the ranker loses
**about one fact in thirty**, which is where it was before this work — the
retrieval gains below are real and the ranking gain was noise.
→ *This is the failure the two-run pair exists to catch*, and it is worth
stating because run A alone would have justified a confident claim that
retrieval had stopped losing anything. Any single-run movement of one or two
facts in this set means nothing.
→ **What did move, and reproduced across both runs:** addressable extraction
+9 points, domain recall 50% → 100%. Both come from the specialists, and the
mechanism is not subtle — Wikipedia and GitHub pages extract reliably in a
corpus where 36% of failures are sites refusing an identified bot.
→ *A new failure category arrived with them:* `response-too-large` at 6%, which
is Wikipedia articles exceeding the 2 MB `EGRESS_MAX_BYTES` cap. That cap is an
egress safety control under Decision 02 and is deliberately **not** raised here.

| Metric | n=10 set | **n=26 set** | Bar |
|---|---|---|---|
| routing accuracy | 100% (n=9) | 100% (n=25) | — |
| extraction rate, raw | 60.3% (n=78 pages) | 54.5% (n=200 pages) | — |
| **extraction, addressable** | **71.2%** (n=66) | **66.9%** (n=163) | **>0.90** |
| **passage recall** | — | **90.0%** (n=20) | **>0.85** |
| **↳ lost by ranking** | — | **3.3%** (n=30 facts) | — |
| citation validity | 100% (n=47) | 100% (n=151) | 1.0 |
| **restraint on unanswerable** | **0%** (n=1) | **0%** (n=1) | — |
| citation faithfulness *(judged)* | 100% (n=3) | not re-run | >0.95 |
| answer correctness *(judged)* | 100% (n=3) | not re-run | >0.80 |

**The addressable rate fell 4.3 points when the set grew, and that is the
honest direction.** 66 readable pages was too few to speak for the corpus; 163
is still not many. A metric that improves every time you look at more of the
world is a metric measuring the sample.

- **Extraction is failing its gate — but by less than it first appeared, and
  for a reason that changes what to do about it.** The first measurement said
  59% against a 90% bar. Naming the HTTP failures by cause rather than lumping
  them as `http-error` showed that **39% of failures are `refused-by-site`** —
  401/403/451 from sites declining to serve an identified bot.

  This is exactly what step 4 predicted: *"The 0.90 gate needs redefining
  before it can be met, and not by improving extraction."* Spoofing a browser
  user agent would move the number and is refused, so the gate now measures
  **addressable** extraction — pages we were allowed to read — and both figures
  are reported. The raw rate is what a reader experiences; the addressable one
  is what an engineer can move.

  | reason | n=10 set | **n=26 set** | ours? |
  |---|---|---|---|
  | `refused-by-site` | 39% | 41% | no — policy, not a bug |
  | `no-main-content` | 23% | 24% | **yes** |
  | `javascript-shell` | 10% | 15% | only with a headless browser |
  | `too-short` | 16% | 8% | **yes** |
  | `timeout` | — | 5% | **yes**, and see below |
  | `rate-limited` | — | 3% | **yes** |
  | `cross-host-redirect` | — | 3% | ours, and deliberate |

  **`no-main-content` and `too-short` are still the work** — 32% of failures
  between them on the larger set, and the two largest buckets anybody here can
  move. The shares held up across a sample two and a half times bigger, which
  is the useful thing the second run bought.

  *Three categories appear only on the larger set*, and two of them cost
  latency rather than quality: `timeout` and `rate-limited` are 8% of failures
  between them, and unlike a `403` they are paid for in wall-clock before they
  fail. See the latency note under step 4.
- **A nonsense query produced three sources and a three-block answer.**
  `empty-nonsense` asks about a specification that does not exist and got a
  confident composition. This is the failure a set without unanswerable queries
  cannot see at all, and it is why one is in the seed. **Unchanged on the
  larger set** — it produced five sources and four blocks on 2026-08-15 — and
  it is still measured over a single query, which is the weakest number in this
  document. Restraint needs its own labelled queries before it means anything.

Neither number was trustworthy at n=10. At n=26 the extraction shares held
within a couple of points while the rate itself moved four, which says the
*composition* of the failures is the stable thing and the headline rate is not.
Work the shares.

**Answer schema, revised 2026-08-15 after a review of a live answer.**
"Australian wildfire" scored 6.5/10 against what Perplexity and Google's AI
Mode have taught readers to expect. Three of the four faults were composition
faults and are fixed; the fourth is retrieval and is not.

- **`TRADEOFF` was being filled because it was listed.** The prompt already
  said "Omit this line if there is nothing real to say" and the model wrote one
  anyway — for a wildfire query it produced a paragraph on how results depend
  on the discovery service. A stronger instruction was not the fix; not
  offering the section was. It now appears only on comparative queries, where
  the trade *is* the answer.
- **`FACTS` replaces it on informational queries**, and asks for dates,
  quantities, names and scale. The same query now returns 800 deaths since
  1851, 100 million hectares in 1974-75, 173 killed at Black Saturday, $A1.9bn
  insured losses.
- **`RELATED` emits a `suggestions` block**, which the wire type and
  `apps/search-web`'s `SuggestionsCard` had both carried since before anything
  produced one. The drift ran the harmless way — a renderer with no data — and
  is exactly the drift the events test exists to catch.
- **Still unfixed: the answer does not lead with the dominant instance.** It
  opens on "a common and significant natural occurrence… for millions of
  years" and never names Black Summer, despite an explicit prompt rule to lead
  with the specific thing that made a broad subject worth searching. The
  passages do not carry a strong Black Summer narrative to lead with, which
  makes this a **retrieval** problem wearing a composition problem's clothes —
  and plausibly the same one the 59% extraction rate describes.
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

> **First slice built, 2026-08-15.** `capability.sites`, `manifests` and
> `capabilities`; `src/probe.ts` as the out-of-band job; a hash join on domain
> in the pipeline; chips on the source card. Verified against
> `demo-calender.cheelalabs.com` (7 capabilities) and
> `demo-shop.cheelalabs.com` (15), with the request-path lookup at 38 ms for
> three domains.
>
> **Not built:** `enrichment`, `phrase_vectors` and `invocations` — the three
> tables that serve capability *retrieval*, matching a query to an action. Also
> absent: the DNS `TXT` sweep and the submission funnel. What exists is the
> opportunistic source only, which is the one weighted by real demand.
>
> **The effects derivation was wrong on its first real run and is worth
> remembering.** It matched the nouns `order` and `payment`, so
> `orders-get-order` and `store-list-payment-methods` — both reads — came back
> `financial`. It keys on verbs now. A chip warning about a payment on a
> capability that only lists them is a false alarm, and false alarms are how
> people learn to ignore the true ones.

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
