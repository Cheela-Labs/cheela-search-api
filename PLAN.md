# apps/search-api

Cheela Search: the query plane, the index, and the pipeline that grows it.

Built against `spec/Cheela_Search_TDS_v1.md` and
`spec/Cheela_Search_Architecture_V1.md`, both committed here so the reasoning is
checkable against the source rather than remembered.

**Status.** Steps 0–7 built; the request path is complete and the index is real
and deployed. No acceptance gate is measured yet, because that needs the service
deployed and `scripts/eval.ts` pointed at it. Steps 9 and 10 are outstanding.

---

## What this is, and what it is not

**It is** the request path (context → intent → evolution → retrieve → rank →
generate), the index those stages read, and the pipeline that keeps the index
growing. One HTTP service, two scheduled Jobs, one Vespa node.

**It is not** the control plane. `apps/server` and this service do not talk, and
nothing here reads a Cheela customer record.

---

## Decisions

### 01 — Own the index

The previous version of this app rented search results and kept a query log
against the day owning an index became affordable. That day was declared. Vespa
runs on a GCE VM, holds all four collections the TDS names, and embeds documents
itself at feed time.

Tavily and AnySearch remain, as **stage B**: they answer what the index cannot
yet, and everything they return is fed into the index, so the same question asked
again is answered for free. `meta.servedFrom` is the number that says whether
that is working, and the whole architecture is a bet on it moving from
`external` to `index`.

**The cost is real and was authorized explicitly**: about $64/month for the VM
and its disk, $38 for Memorystore. Against a project whose recorded position was
"no budget", so it should be revisited rather than inherited.

### 02 — The egress client is the highest-severity code here

On Cloud Run, `169.254.169.254` is the metadata server and it issues tokens for
the service account the revision runs as. This service fetches
attacker-influenceable URLs from two directions — result URLs out of an index
anyone can try to manipulate, and endpoint addresses out of manifests written by
strangers — so an SSRF here is credential theft, not an internal port scan.

`src/infra/egress/` is therefore step 1, before anything that fetches exists. Its
test suite found three real bugs while it was being written, one of which was a
working bypass: `::ffff:127.0.0.1` was **allowed**, because substituting a
placeholder for a trailing dotted quad misplaced the marker bytes so the
IPv4-mapped check never fired. That is why `test/egress/addresses.test.ts` covers
every embedded-IPv4 form by name.

Internal dependencies — Vespa, Redis, Postgres — deliberately do **not** go
through it. They are on private addresses the client refuses, and the distinction
that makes it safe is who chose the address: the egress client exists for URLs
chosen by strangers.

### 03 — Embedding happens inside Vespa

`indexing: input chunks | embed e5` runs the model on the feed path. So there is
no embedding service to run, no embedding cache to keep coherent, and no way for
the vectors in the index to disagree with the text beside them. The cross-encoder
runs in the same place, in `global-phase`.

The cost is that Vespa needs ~1GB more RAM and the config server downloads
~220MB of ONNX on first deploy.

### 04 — The worker is a Job, not a service

The plan had the stream consumer as a Cloud Run service at `min-instances=1` and
costed it at ~$10/month. That was wrong: a consumer needs CPU allocated
*between* requests, and always-allocated CPU is roughly $46/month per vCPU. It is
a Job that Cloud Scheduler wakes, drains the backlog and exits, for a few
dollars.

The trade is indexing latency in minutes rather than seconds, which is the
cheapest time in this system to spend — the user never waits for indexing.
`WORKER_DRAIN_MS` is what makes one binary do both; set it to 0 and deploy as a
service if that stops being true.

---

## Deviations from the specifications

Recorded because the next person will otherwise read the spec, read the code, and
assume one of them is a mistake.

| Spec says | Built as | Why |
|---|---|---|
| `web_document.embedding` | `chunk_embeddings`, a multi-vector | A 4000-word page averaged into one point matches nothing well. Computing both would double feed cost for a vector nothing reads. |
| `Score = IntentBoost × (BM25 + Semantic + …)` | Same sum, each term normalised to 0..1 first | BM25 is unbounded and routinely reaches 20; the other six terms cannot exceed 1. The raw sum is a BM25 ranking with rounding error attached. The formula's shape is the specification; its units were never stated. |
| `Freshness: time decay` | `pow(0.5, age/halflife)`, half-life a query input | An `exp(-age/90d)` form scored a two-year-old page 0.0008 and a five-year-old page zero — a filter, not a decay. The half-life is per-*question*: news wants days, documentation wants years, and the intent engine is what knows which. |
| `packages/shared-types`, `events`, `sdk` | `src/contracts/` in-tree | This app mirrors to a standalone repo where a `workspace:` dependency cannot resolve, and CI rejects one. |
| 13 services, 13 deployables | 13 module boundaries, 4 deployables | Cloud Run scale-to-zero economics. The boundaries are strict; the deployment is not 13 services. |
| Redis for sessions and queue | Redis (Memorystore) for both | As specified. Sessions expire by key TTL, so there is no sweep and no clock for replicas to agree on. |
| `GET /entities/{id}` from the graph | Postgres is the graph; Vespa holds a searchable projection | A graph is a thing you traverse and join. Vespa is neither. |

---

## Build order

Each step had an acceptance criterion, because "retrieval works" and "Recall@10
above 0.85, measured" are different claims and only one can gate the next thing.

| # | Step | State |
|---|---|---|
| 0 | Teardown, provisioning: VM, Memorystore, bucket, firewall | Done — reachable over private ranges only |
| 1 | Config, contracts, egress, robots.txt | Done — 32 tests, three bugs found |
| 2 | Vespa package: four schemas, embedder, cross-encoder | Deployed; cross-encoder verified to reorder |
| 3 | Intent, evolution (RRF k=60), context | Done — RRF checked against hand-computed ranks |
| 4 | Retriever A/B, ranking | Done — **unmeasured** |
| 5 | Generator, `POST /search`, surface migration | Done — surface driven in a browser |
| 6 | Indexer: 10 stages, events, GCS archive | Done |
| 7 | Capabilities, `/entities/{id}`, graph writes | Done |
| 8 | Entity and relation extraction | Done — confidence capped at 0.6 per document |
| 9 | Crawl scheduler on Cloud Scheduler | Frontier and priority built; **not scheduled** |
| 10 | BigQuery analytics, monitoring dashboard | **Not built** |

### What is measurable but unmeasured

`pnpm eval` reports every gate below. None has been run against the real
service, because that needs the deploy. They are targets, not results:

- Recall@10 > 0.85, NDCG@10, Precision@5, MRR
- P95 < 500ms when served from the index
- Citation faithfulness > 0.95
- Intent accuracy > 0.85
- Extraction success > 0.90

**The known risk on latency**: the cross-encoder reranks 30 candidates on two
vCPUs. If P95 misses 500ms, the fixes in order are `RERANK_COUNT`, then a larger
VM. Recorded so the miss is diagnosed rather than absorbed.

---

## Operating it

```bash
docker compose up -d postgres redis vespa       # dev dependencies
pnpm --filter @cheela/search-api db:migrate
pnpm --filter @cheela/search-api vespa:deploy   # local config server
pnpm --filter @cheela/search-api dev

# production Vespa is reachable only from the Cloud Run subnet and via IAP
bash apps/search-api/vespa/deploy.sh --via-iap
bash apps/search-api/deploy/vespa/provision.sh   # idempotent; costs money
```

`/health` reports all three dependencies and stays 200 regardless. That is
deliberate: Cloud Run restarts a container whose health check fails, so coupling
liveness to a dependency turns a brief Vespa blip into a restart loop that takes
the service down harder than the blip would have.

---

## Open questions

1. **Which vertical.** "As good as the others, plus buttons" is not a reason for
   anyone to switch search engines. The query log is the evidence that should
   answer this, and it now exists.
2. **Whether 20 intents is one taxonomy or three.** Half the eval set needed a
   list of acceptable labels rather than one, which is a sign the taxonomy has
   more values than a classifier can reliably separate.
3. **When the index stops needing stage B.** `meta.servedFrom` answers it, and
   the answer decides whether decision 01 was right.
