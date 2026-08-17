
# Cheela Search Technical Design Specification (TDS)

Version: v1.0
Status: MVP Foundation
Target Stack: Vespa, PostgreSQL, Redis, Hono, GCP

## Executive Summary

Cheela Search is an AI-native search engine that combines traditional retrieval, semantic search, a knowledge graph, executable capabilities, and conversational context into one modular platform. External providers (Tavily and AnySearch) bootstrap coverage while every successful search grows Cheela's own index.

## Architecture Goals

- Sub-500 ms search when served from Vespa.
- Learn from every search.
- Treat capabilities as first-class search results.
- Separate retrieval, ranking, generation, and indexing.
- Swap implementations without changing public APIs.

## High-Level Components

- API Gateway
- Query Orchestrator
- Intent Engine
- Query Evolution Engine
- Context Engine
- Retriever
- Vespa
- Ranking Engine
- AI Generator
- Indexer
- Crawl Scheduler
- Knowledge Graph
- Capability Registry
- Analytics

---

# Query Lifecycle

1. Request enters Gateway.
2. Context Engine rewrites follow-ups.
3. Intent Engine classifies.
4. Query Evolution creates retrieval hypotheses.
5. Retriever searches Vespa.
6. Missing coverage triggers Tavily/AnySearch.
7. Ranking merges candidates.
8. Generator produces answer.
9. Background indexing stores new knowledge.

---

# API Specifications

## POST /search

Request

```json
{
  "query":"Australian wildfire",
  "sessionId":"abc",
  "userId":"optional"
}
```

Response

```json
{
  "answer":"...",
  "results":[],
  "capabilities":[],
  "citations":[],
  "followUp":true
}
```

## POST /index/document

Adds a cleaned document.

## POST /capabilities/register

Registers executable actions.

## GET /entities/{id}

Returns knowledge graph information.

---

# Query Orchestrator

Responsibilities

- Route requests.
- Execute parallel retrieval.
- Trigger indexing.
- Publish events.

Pseudo-code

```text
Search
 -> Context
 -> Intent
 -> Evolution
 -> Vespa
 -> External?
 -> Rank
 -> Generate
 -> Return
```

---

# Intent Engine

## Inputs

- Query
- Session
- Entity hints

## Outputs

- Intent
- Confidence
- Rewrite

### Supported intents

- Information
- Event
- Shopping
- Documentation
- Navigation
- Action
- Local
- News
- Comparison
- Image
- Video
- Research
- Finance
- Health
- Travel
- Sports
- Entertainment
- Education
- Coding
- Utility

---

# Query Evolution Engine

Purpose

Generate multiple retrieval hypotheses.

Example

PS5

Produces

- PlayStation 5 reviews
- PlayStation 5 price
- Buy PlayStation 5
- Sony PlayStation 5

Australian wildfire

Produces

- Black Summer fires
- 2019–2020 Australian bushfire season
- Australia wildfire statistics

### Sources

- Knowledge Graph aliases
- Query memory
- Synonyms
- Intent-specific rewrites

### Merge

Use Reciprocal Rank Fusion.

<math block value="RRF(d)=\\sum\\frac{1}{k+r_i(d)}"/>

Default `k = 60`.

---

# Context Engine

Determines follow-ups.

Signals

- Semantic similarity
- Shared entities
- Pronouns
- Session proximity

Example

```text
Australian wildfire
How many died?
```

Rewrites automatically.

Sessions expire after inactivity.

---

# Retriever

## Stage A

Search Vespa.

Collections

- web_document
- capability
- entity
- query_memory

## Stage B

External providers

Parallel requests

- Tavily
- AnySearch

Timeout

- 800 ms soft timeout.

---

# Vespa Design

## Document Schema

Fields

- id
- url
- title
- body
- embedding
- authority
- freshness
- language
- entities

## Capability Schema

Fields

- title
- description
- provider
- auth
- examples
- embedding

## Entity Schema

Fields

- aliases
- popularity
- embedding

## Query Memory Schema

Stores

- normalized query
- click history
- capability success
- frequency

---

# Vespa Ranking Profiles

## Candidate Retrieval

Hybrid search

- BM25
- ANN vector search

## Ranking Formula

<math block value="Score=IntentBoost\\times(BM25+Semantic+Authority+Freshness+EntityBoost+CapabilityBoost+GraphBoost)"/>

### BM25

Primary lexical score.

### Semantic

Cosine similarity.

### Authority

Source reputation.

### Freshness

Time decay.

### Entity Boost

Knowledge graph relevance.

### Capability Boost

Action relevance.

---

# Cross Encoder Reranking

Top 30 candidates.

Output

- reordered list
- confidence score

---

# Knowledge Graph

## Node Types

- Person
- Organization
- Product
- Event
- Place
- Technology
- Capability

## Edge Types

- founded
- owned_by
- located_in
- occurred_in
- part_of
- manufactured_by
- related_to

### Edge Structure

```ts
{
 source,
 relation,
 target,
 confidence
}
```

### Extraction Pipeline

- Named Entity Recognition
- Entity Linking
- Relation Extraction
- Confidence scoring
- Graph insertion

---

# Indexing Pipeline

Pipeline

1. Fetch
2. Clean HTML
3. Canonicalize
4. Deduplicate
5. Chunk
6. Metadata extraction
7. Entity extraction
8. Embedding generation
9. Vespa indexing
10. Graph update

### Chunking

- Target: 300-600 tokens.
- 20% overlap.

### Deduplication

- Canonical URL
- SimHash
- Near-duplicate detection

---

# Crawl Scheduler

Demand-driven.

Priority

<math block value="0.35D+0.30A+0.20F+0.15G"/>

Where

- D = demand
- A = authority
- F = freshness
- G = graph importance

Queue

Redis Streams.

---

# Capability Registry

Capabilities behave like searchable documents.

Example

```json
{
 "title":"Add Calendar Event",
 "provider":"Google Calendar",
 "auth":"OAuth"
}
```

Ranking includes

- intent
- semantic match
- popularity

---

# Events

## SearchExecuted

```json
{
 "query":"",
 "intent":""
}
```

## ExternalFetched

Document ready.

## DocumentIndexed

Index success.

## EntitiesExtracted

Graph update.

## CapabilityRegistered

Capability added.

---

# Storage

| Component | Technology |
|-----------|------------|
| Search | Vespa |
| Metadata | PostgreSQL |
| Sessions | Redis |
| Queue | Redis Streams |
| Objects | Google Cloud Storage |
| Analytics | BigQuery |

---

# Caching

## Query Cache

TTL

- 10 minutes.

## Document Cache

TTL

- 24 hours.

## Entity Cache

TTL

- 1 hour.

---

# Observability

Metrics

- P95 latency
- Recall@10
- MRR
- NDCG
- Cache hit rate
- Index growth

Tracing

- OpenTelemetry.

Logs

Structured JSON.

---

# Failure Recovery

| Failure | Action |
|----------|--------|
| Vespa unavailable | External retrieval |
| Tavily timeout | Continue |
| AnySearch timeout | Continue |
| Index failure | Retry |
| Crawl failure | Requeue |

---

# Security

- OAuth for capabilities.
- API keys.
- Rate limiting.
- Robots.txt compliance.
- Signed internal events.

---

# Testing

## Unit

- Intent
- Evolution
- Ranking

## Integration

- Search pipeline
- Vespa indexing
- External retrieval

## Offline Evaluation

Metrics

- NDCG@10
- Recall@10
- Precision@5
- MRR

Benchmark queries

- Australian wildfire
- PS5
- React useEffect
- Book flight
- Schedule meeting

---

# Deployment

Monorepo

```
apps/
 gateway/
 search/
 generator/
 dashboard/

services/
 orchestrator/
 intent/
 evolution/
 context/
 retriever/
 ranking/
 indexer/
 crawler/
 knowledge-graph/
 capabilities/

packages/
 sdk/
 shared-types/
 events/
```

Infrastructure

- Cloud Run
- Redis
- PostgreSQL
- Vespa cluster
- Cloud Storage

CI

1. Build
2. Test
3. Deploy
4. Smoke tests

---

# Roadmap

## Phase 1

- Vespa
- Intent
- Evolution
- Knowledge Graph
- Capability search
- Tavily
- AnySearch

## Phase 2

- Learning-to-rank
- Personalization
- Better autocomplete
- Rich entity pages

## Phase 3

- Independent crawler
- Real-time indexing
- Multimodal search
- Distributed serving

---

# Future Work

- Reinforcement learning from user satisfaction.
- Graph-powered answer generation.
- Query trend prediction.
- Personalized capability recommendations.
- Autonomous crawl planning.

This TDS intentionally keeps service boundaries strict so individual modules can be replaced, scaled, or rewritten independently while preserving the external contract of Cheela Search.
