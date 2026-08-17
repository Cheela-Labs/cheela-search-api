
# Cheela Search – AI-Native Search Engine Architecture (V1)

## Vision

Cheela Search is an AI-native search engine that gradually becomes independent of external search providers by learning from every query.

Initially it uses **Tavily** and **AnySearch** as external retrieval sources. Every externally retrieved document is cleaned, enriched, indexed into **Vespa**, and connected to a **Knowledge Graph** so future searches become faster, cheaper, and higher quality.

Unlike traditional search engines, **web pages, capabilities (actions), and knowledge graph entities are ranked together**, allowing searches to return both information and executable actions.

---

# Design Principles

1. Memory-first
2. Intent-first
3. Entity-first
4. Action-first
5. Event-driven
6. Modular services

Every service owns one responsibility and communicates through APIs or events.

---

# High-Level Architecture

User
→ API Gateway
→ Query Orchestrator
→ Intent Engine
→ Query Evolution Engine
→ Context Engine
→ Retriever
→ Vespa
→ Ranking Engine
→ AI Generator
→ User

Background services continuously improve the system.

---

# Core Services

| Service | Responsibility |
|---------|---------------|
| API Gateway | Entry point |
| Query Orchestrator | Coordinates search |
| Intent Engine | Detects user intent |
| Query Evolution Engine | Expands ambiguous queries |
| Context Engine | Detects follow-ups |
| Retriever | Local + external retrieval |
| Vespa | Search index |
| Ranking Engine | Scores candidates |
| Generator | AI answer |
| Indexer | Cleans and stores documents |
| Crawl Scheduler | Expands knowledge |
| Knowledge Graph | Entities and relationships |
| Capability Registry | Searchable actions |
| Analytics | Learning signals |

---

# Search Lifecycle

## Step 1: Intent Detection

The Intent Engine classifies queries before retrieval.

Example:

| Query | Intent |
|--------|--------|
| Australian wildfire | Event |
| PS5 | Shopping |
| React useEffect | Documentation |
| Book flight | Action |
| Weather tomorrow | Real-time |

Output:

```ts
{
  intent: "shopping",
  confidence: 0.96,
  entities: ["PlayStation 5"]
}
```

Initial intent taxonomy:

- Information
- Event
- Shopping
- Documentation
- Navigation
- Action
- Local
- News
- Comparison
- Video
- Image
- Research
- Finance
- Travel
- Health
- Entertainment
- Sports
- Education
- Coding
- Utility

---

# Step 2: Query Evolution Engine

This is a core differentiator.

Instead of issuing one search, Cheela generates multiple retrieval hypotheses.

Example:

Query:

```
PS5
```

Expands into:

- PlayStation 5 reviews
- PlayStation 5 price
- Buy PlayStation 5
- Sony PlayStation 5

Another example:

```
Australian wildfire
```

Expands into:

- 2019–2020 Australian bushfire season
- Black Summer fires
- Australia wildfire statistics

The engine uses:

- Intent
- Knowledge Graph aliases
- Popular query memory
- Entity expansion
- Synonyms
- Query rewriting

Each hypothesis is searched independently.

Results are merged using **Reciprocal Rank Fusion (RRF)** before reranking.

This dramatically improves recall while preserving precision.

---

# Step 3: Context Engine

The Context Engine decides whether a query continues a previous search.

Example:

```
Australian wildfire
How many died?
```

Becomes:

```
How many people died in the 2019–2020 Australian bushfire season?
```

Signals:

- semantic similarity
- shared entities
- pronouns
- recent session history

Session expires after inactivity.

---

# Step 4: Retrieval

Retrieval happens in stages.

## Stage A

Search Vespa first.

Collections:

- web documents
- capabilities
- knowledge graph entities
- popular query memory

If confidence is high:

Return immediately.

## Stage B

If confidence is low:

Search external providers in parallel.

- Tavily
- AnySearch

Parallel execution minimizes latency.

---

# Step 5: Hybrid Ranking

Candidates from every source are merged.

Ranking signals:

- BM25
- semantic similarity
- authority
- freshness
- entity relevance
- capability relevance
- intent compatibility

Formula:

```
FinalScore =
IntentBoost × (
    TextScore +
    SemanticScore +
    Authority +
    Freshness +
    EntityBoost +
    CapabilityBoost +
    GraphScore
)
```

Top candidates are reranked with a cross-encoder.

---

# AI Generation

The generator receives:

- top ranked documents
- capabilities
- entities
- citations

Output includes:

- AI answer
- citations
- suggested actions

Example:

Query:

```
Schedule meeting tomorrow
```

Returns:

- AI explanation
- Google Calendar capability
- Outlook capability

---

# Vespa Schemas

## Web Document

```ts
{
  id,
  url,
  title,
  body,
  embedding,
  authority,
  freshness,
  language,
  entities
}
```

## Capability

```ts
{
  id,
  title,
  description,
  provider,
  auth,
  examples,
  embedding
}
```

## Entity

```ts
{
  id,
  name,
  type,
  aliases,
  popularity,
  embedding
}
```

## Query Memory

```ts
{
  query,
  normalizedQuery,
  frequency,
  clickedDocs,
  successfulCapabilities
}
```

---

# Knowledge Graph

The Knowledge Graph is a long-term asset.

Every indexed document extracts:

- people
- organizations
- products
- places
- events
- technologies
- capabilities

Example relationships:

Larry Page
→ founded
→ Google

PS5
→ manufactured by
→ Sony

Australian Bushfire Season
→ occurred in
→ Australia

Each edge stores confidence.

Benefits:

- entity disambiguation
- better follow-ups
- related searches
- richer ranking
- future timeline views

---

# Self-Improving Indexing Pipeline

Every externally retrieved document enters an asynchronous pipeline.

Pipeline:

1. Fetch HTML
2. Clean
3. Canonicalize URL
4. Deduplicate
5. Chunk
6. Extract metadata
7. Extract entities
8. Update Knowledge Graph
9. Generate embeddings
10. Index into Vespa

The user never waits for indexing.

---

# Demand-Driven Crawl Scheduler

Rather than crawling randomly, Cheela expands around high-demand searches.

Priority formula:

```
0.35 × Demand
+0.30 × Authority
+0.20 × Freshness
+0.15 × GraphImportance
```

Example:

Repeated searches for Australian wildfire trigger crawling of:

- government reports
- Wikipedia
- scientific papers
- trusted news archives

---

# Capability Registry

Capabilities are indexed exactly like documents.

Example:

```ts
{
  id: "calendar.add_event",
  title: "Add Calendar Event",
  description: "...",
  provider: "Google Calendar",
  auth: "OAuth"
}
```

Capabilities compete with web pages during ranking.

---

# Event-Driven Learning

Everything publishes events.

Important events:

- SearchExecuted
- ExternalFetched
- DocumentIndexed
- EntitiesExtracted
- CapabilityRegistered
- CrawlCompleted

Consumers remain independent.

---

# Storage Stack

| Data | Technology |
|------|------------|
| Search | Vespa |
| Metadata | PostgreSQL |
| Sessions | Redis |
| Queue | Redis Streams |
| Objects | Google Cloud Storage |
| Analytics | BigQuery (later) |

---

# APIs

## Search

```
POST /search
```

Returns:

- AI answer
- ranked results
- capabilities
- citations
- follow-up metadata

## Index

```
POST /index/document
```

## Capability Registration

```
POST /capabilities/register
```

## Knowledge Graph

```
GET /entities/{id}
```

---

# Repository Structure

```
apps/
  gateway/
  search/
  generator/
  dashboard/

services/
  orchestrator/
  intent/
  query-evolution/
  context/
  retriever/
  ranking/
  indexer/
  crawler/
  knowledge-graph/
  capabilities/

packages/
  shared-types/
  events/
  sdk/
```

Each service owns:

- API
- tests
- configuration
- deployment

No shared business logic.

---

# Future Roadmap

## Phase 1

- Vespa
- Tavily
- AnySearch
- AI answers
- Capability search
- Query Evolution
- Knowledge Graph
- Demand-driven crawling

## Phase 2

- User personalization
- Learning-to-rank
- Rich entity pages
- Timeline search
- Better autocomplete

## Phase 3

- Independent crawler
- Real-time indexing
- Multimodal search
- Large-scale distributed serving

---

# Why This Architecture

The long-term moat is not merely storing documents. It is the continuous feedback loop:

1. A user searches.
2. Intent clarifies meaning.
3. Query Evolution explores multiple interpretations.
4. Vespa serves cached knowledge.
5. External providers fill gaps.
6. New information is indexed.
7. Entities enrich the Knowledge Graph.
8. Future searches become faster and smarter.

Over time, Tavily and AnySearch become bootstrap providers rather than primary dependencies, while Vespa, the Knowledge Graph, and Query Memory become Cheela's proprietary retrieval layer.
