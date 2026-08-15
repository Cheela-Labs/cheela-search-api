# The eval set

PLAN.md: *"The 200 labeled queries are a writing task, not a coding one; start
them at step 0."* They were not started at step 0. This directory is where they
go, and `scripts/eval.ts` is the harness that reads them.

## Why the format lets a query be half-labelled

Labelling is the expensive part, and a harness that needs a complete label
before a query counts for anything is a harness nobody finishes filling in. So
**every field except `query` is optional**, and each metric is computed over
the subset of queries that carry the label it needs.

Two consequences worth stating plainly:

- A file of bare queries — no labels at all — already measures extraction
  rate, citation validity and answer shape. Those are the metrics that need no
  ground truth, and one of them is a Phase 0 gate.
- Adding `expectDomains` to ten queries makes recall measurable over ten
  queries, and the report says `n=10` rather than pretending to speak for the
  set. A metric computed over four queries is reported as such.

## Do not label from the current output

The temptation is to run a query, look at what came back, and write those
domains into `expectDomains`. That produces a set that scores 1.0 today and
can never detect a regression, because it *is* a recording of today.

Label from what a correct answer would need. If you do not know, leave it out —
an absent label is honest and a circular one is worse than nothing.

## Fields

```jsonc
{
  // Required. The only required field.
  "query": "what is the agent discovery specification",

  // Stable across edits, so a result history can be joined on it.
  "id": "ads-what-is",

  // Why this query is in the set. For a human reading a regression, not for
  // the harness. Skipping it is how a set becomes 200 queries nobody can
  // reason about.
  "why": "The canonical informational query for our own domain.",

  // What the router should say. Measures routing accuracy in isolation —
  // a query that retrieves badly because it was routed wrong is a routing
  // bug, and per-stage numbers exist to tell those apart.
  "intent": "informational",

  // Domains a correct answer must draw on. Recall is the fraction of these
  // that appear among the sources. Not URLs: a page moves, a site does not,
  // and a URL-level label rots faster than it is worth.
  "expectDomains": ["a2aproject.github.io"],

  // Substrings a correct answer should contain, lowercased before comparison.
  // A crude proxy for correctness that costs no model call — it catches an
  // answer about the wrong subject, which is the failure worth catching
  // cheaply. The judge is for everything subtler.
  "mustMention": ["capability", "discovery"],

  // Expected to return nothing useful. Rare and valuable: a set with no
  // unanswerable queries cannot tell a confident wrong answer from a right
  // one, and confident wrong answers are the failure mode that matters.
  "expectEmpty": false
}
```

## Running it

```bash
# Deterministic metrics only. No model calls, no cost beyond the queries
# themselves.
pnpm --filter @cheela/search-api eval

# Adds the LLM judge for citation faithfulness and answer correctness —
# the two Phase 0 gates that need one. Costs a model call per answer.
pnpm --filter @cheela/search-api eval -- --judge

# A subset, while iterating on one stage.
pnpm --filter @cheela/search-api eval -- --only ads-what-is
```

**The judge is not neutral.** It is a model grading a model, and by default the
same one that composed the answer. PLAN.md pairs it with a weekly human
spot-check for exactly that reason: treat a judged score as a regression
signal, not as truth. `--judge-model` overrides it, and using a different
family than `COMPOSER_MODEL` is the cheapest way to make the grade mean more.
