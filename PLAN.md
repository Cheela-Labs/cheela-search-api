# apps/search-api — delivery plan

**Status:** not started · **Scope:** Phase 0 through Phase 2
**Architecture:** `docs/capability-search-architecture.md` (rev 2, 2026-08-11)
**Consumer:** `apps/search-web`, which already speaks this service's event contract

This is the query plane: query in, cited answer out, with an action layer where
a site's manifest says one exists. The architecture document argues for the
shape; this one says what gets built in this directory, in what order, and what
has to be true before the next thing starts.

---

## What this service is, and what it is not

**It is** the request path. Route the query, retrieve, rank, compose, stream.
One process, stateless, horizontally scalable, holding no session.

**It is not** the crawler. Manifest probing and content crawl-ahead run on their
own schedule against the same database and belong in `apps/crawler`. Putting
them here would tie a background job's memory profile and failure modes to the
latency of a user-facing request, and the first slow crawl would take the search
box down with it.

**It is not** the control plane. `apps/server` learns nothing about search
beyond an ingest endpoint for first-party runtimes. Different blast radius,
different backup needs, different scaling curve — a bad crawl must not be able
to reach billing.

---

## The contract is already written

`src/shared/events.ts` is the wire format, and `apps/search-web` consumes it
today against its own fixture corpus. That ordering was deliberate: the surface
exists, so every phase below has a working consumer to be tested against rather
than a mock.

Two properties of the contract are load-bearing and neither is negotiable
during implementation:

1. **Sources and capability events are emitted before the first answer block.**
   The capability lookup is a hash join on domains that have already arrived; it
   completes roughly two seconds before composition does. A pipeline that
   batches its output throws that away, and the surface has no way to get it
   back.
2. **`error` is a frame, not a status code.** A 500 tells the surface that
   something failed; an error event tells the person what. The stub in
   `src/app.ts` already answers this way, which is why the two halves can be
   wired together before either is finished.

Changes go in this file first. This side produces events; a producer emitting
something the consumer has not learned to read is the recoverable direction, and
the reverse is a blank screen.

---

## Phase 0 · Search — ~4 weeks

**A search engine that works. No ADS anywhere in it.** This is the MVP and it is
useful on its own.

### Build order

1. **Egress client** (`src/infra/egress`). One client, one policy, used by every
   outbound fetch in both planes. Resolve DNS first and reject RFC1918,
   loopback, link-local and `169.254.169.254`; pin the resolved IP so DNS cannot
   rebind between check and connect; refuse cross-host redirects; cap response
   size and wall-clock time. Two implementations means one of them is wrong, so
   this is first and everything else is built on top of it.
2. **Upstream provider interface** (`src/infra/upstream`) with **two vendors
   behind it from day one**. Not "designed for two" — two, wired, switchable by
   config. A single search vendor is a single point of both cost and
   termination, and the second one never gets added under pressure.
3. **Fetch and extract** the top 6–10 candidates in parallel. Main-content
   extraction, boilerplate stripped, hard per-URL timeout. A slow page is
   dropped, never waited on.
4. **Chunk, embed, rerank** against the query. Keep ~12 passages.
5. **Compose** with a citation per claim, streamed as blocks.
6. **The three caches**, instrumented from the first commit.
7. **Eval harness** and its 200 labeled queries.

### The three caches

| Cache | Key | TTL | Why |
|---|---|---|---|
| Query → URLs | normalized query + provider | short | Rankings move |
| URL → extracted content | canonical URL | long, revalidated | Pages mostly do not |
| Chunk → embedding | `(content_hash, model_version)` | permanent | Embedding the same paragraph twice is pure waste |

The second is the strategic one. It fills along the shape of real traffic, so
head queries go warm quickly and the upstream bill flattens against volume
rather than tracking it.

**Cache hit rate decides unit economics outright at MVP** — the dominant cost per
query is upstream API calls and page fetches, not model tokens and not vector
search. Instrument it before optimizing retrieval quality, not after.

### Gate out of Phase 0

- Answer correctness > 0.80 (judge, with weekly human spot-checks to keep the
  judge honest)
- Citation faithfulness > 0.95 — does the cited passage actually support the
  claim
- Extraction success rate > 0.90 — silent extractor failures look exactly like
  model failures
- Content cache hit rate > 0.55

If the search engine is not good, no action layer rescues it.

---

## Phase 1 · Discovery — ~3 weeks

**Results that know what a site can do.** The capability index joins to results
by domain. Nothing is invoked; this phase is pure information gain and carries
no execution risk.

- Tolerant manifest reader with the five-outcome result type. An unrecognized
  `transport` or `auth` **does not remove a capability from the index** — we
  cannot call it, but the site still does this and the user should still be told.
- Unknown fields and `extensions` stored verbatim. A field dropped today is a
  feature that cannot ship tomorrow without a full re-crawl.
- A major `specVersion` ahead of ours stops the read. Do not guess at a document
  written to rules we have not seen.
- Enrichment: 8–15 intent phrases per capability, embedded individually, **never
  the identifier**. `com.example.lookupOrder` is a poor retrieval target for
  "where's my package" and no amount of embedding-model shopping closes that gap.
- Hybrid retrieval — lexical on provider names, dense on phrases, structured
  predicates on transport, auth, effects tier and trust, **in one statement**.

> **Invariant.** Manifest text can only *lower* a capability's privilege, never
> raise it. The effects tier is ours, derived from structure — the verb in the
> name, the shape of the schemas, the endpoint. If a manifest describes
> `deleteAllRecords` as "safely previews your data", our verdict stands and the
> mismatch is itself a demotion signal.

**Gate:** capability recall@50 > 0.92, and chips visibly ahead of the answer in
the streamed response — which the surface will show you directly.

Phase 1 also measures the thing the whole product bets on: chips are rendered
and nothing is invoked, so click-through tells you the real demand for actions
before the invoker exists. That measurement is the actual purpose of this phase.

---

## Phase 2 · Action — ~3 weeks

**Read-only calls, narrowest possible surface.** Transport we speak, auth we can
satisfy, domain verified, `read` tier, schema present. In practice that means
Cheela's own broker plus early ADS adopters.

- Planner and binder, with **Ajv pre-validation against the declared
  `inputSchema` before any network call, always, including at `read` tier**. Use
  the Ajv instance already in `@cheela/adp` rather than a second one.
- A validation failure is **a UI state, not an error**: it means a required
  argument is missing, so render the card with a field for it and stop.
- No `inputSchema` at all is permitted and common in hand-written manifests.
  Unvalidatable input is `unknown` effects tier by definition and cannot be
  auto-invoked.
- Budgets: max 3 invocations per query, max 1 provider unless the query names
  several, hard wall-clock ceiling per stage, per-provider circuit breaker.
- **Retrieval and action must not share a context window.** This is the
  structural defense against injection from page content, and it is why
  composition happens after invocation rather than around it. Nothing retrieved
  may influence the planner's policy or the gate.

> **Invoking someone's capability spends their money.** Read
> `apps/server/src/domain/capability/invoke-capability.ts` — a broker call is
> metered against the *runtime owner*. Identified user agent, robots honored,
> opt-out via a manifest extension, never invoke during crawl, and an
> operator-facing log of every call we made and why.

**Gate:** zero ungated invocations across the full eval suite plus a red-team
pass. This one does not negotiate.

---

## Phase 3 · Consent — not in scope

Writes and third-party credentials. Design the effects tier and the gate to
accommodate it now; build none of it until Phase 2 has run in production for a
quarter. It is a compliance project wearing an engineering costume.

---

## Storage

Postgres 16 with pgvector, two schemas in one instance — `web` and
`capability`. Split so the web side can move out later without touching the
capability side. `docker-compose.yml` already runs Postgres 16 for SuperTokens,
so local dev costs one more database on a container that is already there.

Not the control plane's Mongo, for any of it.

Resist a dedicated vector store on the capability side specifically: those
queries need lexical, dense and structured predicates in one statement, and a
vector database makes the predicates a post-filter — which wrecks recall exactly
when the filter is selective, and here it always will be.

**The whole cross-plane integration is `documents.domain → sites.domain`.** Keep
it that way. Every temptation to make the join smarter buys marginal precision
and costs the property that either plane can be rebuilt, replaced or emptied
without the other noticing.

---

## Configuration

`src/shared/config.ts` parses once at import and freezes. Nothing is required
yet — that is Phase 0 not having started, not a decision. **Each variable
arrives as a required field at the same time as the code that reads it.** A
variable made optional so the service can boot without it is a variable that
will be missing in production.

| Phase | Adds |
|---|---|
| now | `PORT`, `LOG_LEVEL`, `ALLOWED_ORIGINS`, `NODE_ENV` |
| 0 | `DATABASE_URL`, two upstream provider keys, embedding + rerank model pins, per-stage LLM model pins, egress timeout and size caps |
| 1 | crawler ingest token, enrichment model pin |
| 2 | broker base URL, per-provider budget ceilings |

For the LLM stages go through `@cheela/provider` rather than a vendor SDK.
Routing, reranking, planning and composition have genuinely different cost and
latency profiles, and you will want a different model pinned per stage and to
change your mind about all four.

---

## Testing

`test/app.test.ts` asserts the **wire encoding**, not the types.
`src/shared/events.ts` is duplicated in `apps/search-web` — both apps build
standalone from their own mirrors, so TypeScript cannot catch a drift between
them. A test on the bytes can.

Build the eval harness in week one. Every stage here has a plausible-sounding
improvement that makes end-to-end quality worse — a better embedding model that
loses proper nouns, a cheaper extractor that drops the answer, a smarter planner
that invokes more. Without per-stage measurement you will ship all of them and
be unable to tell which one did the damage. Two hundred labeled queries is a
couple of days and it is the line between engineering and vibes.

**Ungated invocations is a release blocker at any value above zero.** It is not
a quality metric and it does not get traded against anything.

---

## Open questions

These are genuinely undecided, not rhetorical.

- **Which two upstream providers.** The interface is fixed by Phase 0 step 2;
  the vendors are not. Pick on cost per thousand queries and on termination
  risk, not on snippet quality — we do not use their snippets.
- **Where this deploys.** `apps/server` and the Next apps have a documented
  path in `deployment.md`; this one has none yet. It holds long-lived streaming
  connections and talks to Postgres, which rules out some of the hosts the
  static sites use.
- **Whether the crawler is a second app or a second entrypoint here.** Separate
  app is the stated position and the reasoning above stands, but it costs a
  second deploy target and a second mirror, and that is worth re-arguing once
  Phase 1 has a real crawl volume to reason about.
- **Vertical.** "As good as the others, plus buttons" is not a reason to switch
  search engines. The mitigation in the architecture doc is to pick a vertical
  where actions are the point — commerce, travel, support, local services — and
  be the best engine in it. That choice is not made, and Phase 1's click-through
  data is what should make it.
