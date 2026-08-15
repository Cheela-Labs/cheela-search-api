# Monitoring

PLAN.md accepts step 7 when *"hit rate is on a dashboard, from the first day it
can be"*, and argues why it is that metric and not another: **cache hit rate
decides unit economics outright at MVP**, because the dominant cost per query is
upstream API calls and page fetches, not model tokens and not vector search.

This directory is that dashboard, as code.

```bash
./monitoring/apply.sh              # uses the current gcloud project
./monitoring/apply.sh PROJECT_ID   # or name one
```

Idempotent — it updates what exists and creates what does not.

## Why the number could not come from `/health`

`/health` reports the same counts and cannot be the dashboard. The counters
live in the process, so they reset every time an instance is replaced, and a
service that scales to zero spends most of its life having just forgotten
everything it knew. Scraping them would sample a number that restarts at zero
on a schedule nobody controls.

So `src/shared/metrics.ts` emits one structured line per cache decision, and
Cloud Monitoring counts them. The counters stay for a local read and for the
tests; they are no longer pretending to be the metric.

The line names no query, no URL and no caller — the property that lets
`/health` sit outside the token gate, kept true on the way out. `test/cache.test.ts`
asserts the exact key set so that adding a field is a decision somebody has to
make on purpose.

## The pieces

| File | What it is |
|---|---|
| `cache-lookup-metric.yaml` | The log-based metric. One metric, two labels: `cache` and `outcome` |
| `cache-dashboard.json` | Four widgets — a hit-rate scorecard per cache, and lookups over time |
| `apply.sh` | Creates or updates both |

**The field names are a contract across two systems.** `labelExtractors` in the
YAML reads `jsonPayload.cache` and `jsonPayload.outcome`, and the filter matches
`jsonPayload.metric="cache_lookup"`. TypeScript cannot check that, because the
other end is a YAML file in another system — rename a field in `metrics.ts` and
nothing fails, the metric just matches nothing and the dashboard reports a
confident, empty zero. That is why the names are asserted in the test suite.

## Reading it

The content scorecard carries the Phase 0 gate — **> 0.55** — as a threshold, so
the widget itself says whether the gate is met rather than leaving it to
somebody's memory.

Hit rate is `(hit + revalidated) / all`, matching `summarize()` in
`metrics.ts`. **Revalidated is a third outcome, not a kind of hit.** A `304`
still costs a round trip but no bandwidth, no extraction and no re-chunking:
folding it into hits overstates the saving, folding it into misses understates
it against the gate. The stacked chart keeps all three visible for the same
reason.

The query-cache panel is a different unit of money. One hit there is one vendor
call not bought, where one content hit is one page not fetched.

## Two things that look like faults and are not

- **A log-based metric does not backfill.** It counts lines ingested after it
  was created, so the dashboard is empty until the first deploy that emits them,
  and stays empty for a few minutes after. Applying before deploying is the
  right order.
- **A scale-to-zero service reports nothing while it sleeps.** Gaps in the
  chart are gaps in traffic. The scorecard aligns over an hour so a quiet
  afternoon does not read as a collapsed hit rate.

## Not wired into the build

`cloudbuild.yaml` does not run `apply.sh`. These are two project-level objects
that change roughly never, while the build runs on every push — wiring them
together would mean every deploy needs permission to rewrite the monitoring
configuration, which is a much wider grant than shipping a container needs. See
Decision 02 in PLAN.md on why this service's identity is kept narrow.
