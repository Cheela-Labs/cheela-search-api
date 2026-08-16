import type {
	CapabilityStore,
	SiteCapability,
} from "../infra/db/capability-store";
import type { DocumentStore } from "../infra/db/document-store";
import type { QueryLog } from "../infra/db/query-log";
import type { EgressClient } from "../infra/egress/client";
import type { SearchRotation } from "../infra/upstream/rotation";
import { type Candidate, interleaveAll } from "../infra/upstream/types";
import type { Place, SearchEvent, Source } from "../shared/events";
import type { Composer } from "./compose/types";
import { sourcesFrom, swatchFor } from "./compose/types";
import {
	type RetrievalOutcome,
	type RetrievalStats,
	type RetrievedPage,
	retrievePages,
} from "./retrieval/fetch";
import { type Passage, selectPassages } from "./retrieval/rank";
import type { Classifier } from "./route/classifier";
import { routeStructurally } from "./route/structural";

/**
 * The query pipeline: query in, events out.
 *
 * The event *ordering* here is the contract, not an implementation detail. Two
 * properties are load-bearing and the surface cannot recover either if this
 * gets them wrong:
 *
 * 1. **Sources are emitted before the first answer block.** They exist a full
 *    stage earlier than the answer does, and a pipeline that batches its output
 *    hands the surface everything at once — which is slower to read even though
 *    it is not slower to compute.
 * 2. **Failure is an `error` event, not a thrown exception.** The caller turns
 *    this into a stream that has already begun; there is no status code left to
 *    send. A query that retrieved nothing is a normal outcome and says so in the
 *    trace, rather than being an error at all.
 */

export type PipelineDeps = {
	upstream: SearchRotation;
	egress: EgressClient;
	composer: Composer;
	classifier: Classifier;
	/**
	 * The permanent demand record. Optional — a search must not fail because
	 * the log could not be written, and the pipeline ran without one for its
	 * whole life before step 7.
	 */
	queryLog?: QueryLog;
	/** The content cache, threaded through to the fetch stage. */
	documents?: DocumentStore;
	/**
	 * The capability index. Optional, like every other store here.
	 *
	 * Read as a hash join on domain and nothing more — PLAN.md is explicit that
	 * a manifest fetched during a query "would blow the 60 ms capability-lookup
	 * budget and the 'chips visible before the answer' argument with it". The
	 * fetching happens in `dist/probe.js`, out of band.
	 */
	capabilities?: CapabilityStore;
	/**
	 * A measurement seam for the eval harness. Never affects behaviour.
	 *
	 * Extraction success rate is one of the four Phase 0 gate metrics
	 * (>0.90), and the only other way to read it is to parse
	 * `Read N relevant pages` out of a human-facing stage label — a gate
	 * number should not depend on the wording of a UI string. The stats are
	 * already computed here; this hands them to a caller that asked.
	 *
	 * Not an event, deliberately: `SearchEvent` is a wire contract that
	 * `apps/search-web` duplicates and `test/app.test.ts` asserts on the bytes,
	 * and a measurement detail has no business in it.
	 */
	onRetrieval?: (stats: RetrievalStats) => void;
	/**
	 * The passages that survived ranking, and the pages they were drawn from.
	 * A measurement seam like `onRetrieval`, and like it, never affects
	 * behaviour.
	 *
	 * Both halves, because one without the other cannot attribute a miss. Step
	 * 5's acceptance criterion is "recall on the labeled set ... per-stage
	 * rather than end-to-end", and per-stage here means a three-way split that
	 * needs exactly these two arguments to compute:
	 *
	 * - a fact in neither the pages nor the passages → retrieval or extraction
	 * - a fact in the pages but not the passages    → **the ranker dropped it**
	 * - a fact in the passages but not the answer   → composition
	 *
	 * The middle one is the number that decides the embedding stage PLAN.md
	 * deferred. If BM25 is losing nothing that was fetched, a semantic ranker
	 * has no headroom to buy on the request path, and the deferral was right.
	 */
	onPassages?: (
		kept: readonly Passage[],
		available: readonly RetrievedPage[],
	) => void;
	/** Candidate URLs requested from the upstream provider. */
	candidateLimit?: number;
	/** Passages kept for composition. */
	passageLimit?: number;
};

const DEFAULT_CANDIDATES = 8;
const DEFAULT_PASSAGES = 12;

/**
 * How many extra pages a discovery query may read, over the normal budget.
 *
 * Not zero, because two searches merged into one budget would halve the general
 * results a discovery answer still needs — "best laptop for video editing"
 * wants the review that compares them as much as the shop that sells them. Not
 * large either: the read stage runs six at a time, so this is one extra wave at
 * most and the deadline is per page regardless.
 */
const DISCOVERY_EXTRA = 4;

/**
 * Merges two candidate lists, alternating, keeping the first sight of each URL.
 *
 * `primary` goes first at every step because on a discovery query it is the
 * rewritten search — the one that went looking for places. Alternating rather
 * than concatenating matters: the tail of a list is where the weak results live,
 * and appending would spend the extra budget on one list's dregs while the other
 * list's second-best result never got fetched.
 *
 * The mechanism lives in `interleaveAll` because the upstream fan-out needs the
 * same policy for the same reason, and two implementations of a merge is how
 * they quietly stop agreeing.
 */
function interleave(
	primary: readonly Candidate[],
	secondary: readonly Candidate[],
	limit: number,
): Candidate[] {
	return interleaveAll([primary, secondary], limit);
}

/**
 * Turns retrieval outcomes into destinations, in the order they were searched.
 *
 * Deliberately built from *outcomes* rather than from pages: the pages are what
 * extracted, and on a discovery query those are disproportionately the articles
 * about the thing rather than the places that have it. A storefront that failed
 * extraction still answered, still has a host, and usually still declared a
 * title and an image — all a link needs.
 *
 * A candidate that never got a response is dropped. We know nothing about it
 * beyond an upstream provider's assertion that it exists, and sending a reader
 * somewhere we could not reach ourselves is worse than showing one fewer card.
 */
function placesFrom(
	candidates: readonly Candidate[],
	outcomes: readonly RetrievalOutcome[],
	/** URLs the rewritten, places-seeking search returned. */
	preferred: ReadonlySet<string>,
): Place[] {
	const byUrl = new Map(
		outcomes.map((outcome) => [
			outcome.ok ? outcome.page.requestedUrl : outcome.requestedUrl,
			outcome,
		]),
	);

	const ranked: { place: Place; rank: number }[] = [];
	const seen = new Set<string>();

	for (const candidate of candidates) {
		const outcome = byUrl.get(candidate.url);
		if (outcome === undefined) continue;

		const resolved = outcome.ok
			? {
					url: outcome.page.finalUrl,
					domain: outcome.page.domain,
					title: outcome.page.extraction.title,
					image: outcome.page.extraction.image,
				}
			: {
					url: outcome.finalUrl,
					domain: outcome.domain,
					title: outcome.preview?.title ?? null,
					image: outcome.preview?.image ?? null,
				};

		// No `finalUrl` means no response arrived — a refused address, a timeout,
		// a connection that never opened.
		if (!resolved.url || !resolved.domain) continue;
		if (seen.has(resolved.domain)) continue;
		seen.add(resolved.domain);

		ranked.push({
			place: {
				id: `place-${ranked.length}`,
				domain: resolved.domain,
				url: resolved.url,
				title: resolved.title ?? candidate.title ?? resolved.domain,
				swatch: swatchFor(resolved.domain),
				...(resolved.image ? { image: resolved.image } : {}),
			},
			// Two preferences, in this order. Coming from the rewritten search
			// outranks having a picture, because that search is the one that asked
			// for places: Wikipedia's Air Jordan article has an excellent image and
			// is not a shop, and sorting on the picture alone floats it to the top
			// of a row whose entire purpose is telling the reader where to go.
			rank: (preferred.has(candidate.url) ? 0 : 2) + (resolved.image ? 0 : 1),
		});
	}

	// Stable, so within a rank the upstream's own ordering survives.
	return ranked.sort((a, b) => a.rank - b.rank).map((entry) => entry.place);
}

/**
 * Attaches the capability index to whichever sources this answer produced.
 *
 * One function, used by **both** answer paths, because they had drifted: the
 * navigational shortcut returned its source without ever consulting the index,
 * so typing a site's own address — the query most likely to mean "what can this
 * site do?" — was the single path that could never show a capability. The bug
 * was invisible in the code because the lookup lived inline in the long path
 * and the short path simply ended earlier.
 *
 * The read is one indexed statement for every domain at once. The write is
 * `INSERT ... DO NOTHING`, noting that these domains exist so the probe job can
 * look at them later — the opportunistic source PLAN.md prefers, "weighted by
 * what people actually search for, which beats any static ranking list".
 *
 * Neither fetches anything. A domain seen for the first time contributes no
 * chips to *this* answer and may contribute some to the next one.
 */
async function attachCapabilities(
	sources: readonly Source[],
	capabilities: CapabilityStore | undefined,
): Promise<void> {
	if (!capabilities || sources.length === 0) return;

	const domains = [...new Set(sources.map((source) => source.domain))];
	const known: Map<string, SiteCapability[]> =
		await capabilities.capabilitiesFor(domains);

	// Not awaited. Nobody is waiting on it, it swallows its own errors, and
	// putting a write between the sources and the first answer block would
	// spend the latency the event ordering exists to protect.
	void capabilities.enqueue(domains);

	for (const source of sources) {
		const found = known.get(source.domain) ?? [];
		if (found.length === 0) continue;
		source.capabilities = found.map((capability) => ({
			domain: capability.domain,
			// The spec allows `invocationName` to be absent; the wire type does
			// not, so fall back to the identity rather than dropping a real
			// capability over a presentation field.
			invocationName: capability.invocationName ?? capability.name,
			effects: capability.effects,
			callable: capability.invocableByUs,
		}));
	}
}

/**
 * The navigational answer: the site, and nothing else.
 *
 * No upstream call, no fetch, no rerank, no model — roughly 350 ms and no cost,
 * against ~2.6 s and eight page fetches for a query that wanted one link. The
 * page is not read, so there is nothing to cite and nothing is claimed about
 * what it says.
 *
 * **It does still ask the capability index**, and that is worth the one indexed
 * statement it costs. This is the query where an action layer is most obviously
 * the answer: somebody who typed `demo-calender.cheelalabs.com` wants that
 * site, and what the site can *do* is the most useful thing we know about it
 * that a plain link does not carry. Skipping the lookup here saved ~38 ms on
 * the one query whose whole value it is.
 */
async function* navigational(
	url: string,
	capabilities: CapabilityStore | undefined,
): AsyncGenerator<SearchEvent> {
	const { hostname } = new URL(url);

	yield {
		type: "stage",
		stage: { id: "route", state: "done", label: `Going to ${hostname}` },
	};
	yield { type: "crawled", count: 0 };

	const source: Source = {
		id: "nav",
		n: 1,
		domain: hostname,
		path: hostname,
		url,
		title: hostname,
		swatch: swatchFor(hostname),
		passages: [],
	};

	// Before the source is emitted, not after: the surface renders the card once
	// and the chips are part of it. An event stream cannot revise a card it has
	// already sent.
	await attachCapabilities([source], capabilities);

	yield { type: "source", source };
	yield {
		type: "block",
		block: {
			kind: "answer",
			id: "answer",
			spans: [
				{ kind: "text", text: hostname },
				{ kind: "cite", n: 1 },
			],
		},
	};
	yield { type: "done" };
}

export async function* runPipeline(
	query: string,
	deps: PipelineDeps,
	signal?: AbortSignal,
): AsyncGenerator<SearchEvent> {
	const aborted = () => signal?.aborted === true;

	try {
		yield {
			type: "stage",
			stage: { id: "search", state: "active", label: "Searching the web" },
		};

		// A query that is already an address needs no index consulted to find the
		// page it names. This is the one intent worth knowing *before* the search,
		// and the only one that skips retrieval entirely.
		const structural = routeStructurally(query);
		if (structural.intent === "navigational") {
			yield { type: "intent", intent: "navigational" };
			yield* navigational(structural.url, deps.capabilities);
			return;
		}

		// Classification runs *concurrently* with the upstream call rather than
		// ahead of it. The verdict is needed at composition, not at retrieval —
		// every remaining intent reads the same pages — so a classifier that
		// resolves inside the search's own 500–1700 ms costs nothing at all.
		// Awaiting it first would add its full latency to every query.
		const limit = deps.candidateLimit ?? DEFAULT_CANDIDATES;
		const classifying = deps.classifier(query, signal);
		const searching = deps.upstream.search(query, { limit, signal });

		// A discovery query gets a second search, for the places rather than the
		// explanations — "nike jordans" returns Wikipedia, "buy nike jordan
		// sneakers online store" returns shops.
		//
		// Chained off the classifier rather than sequenced after the first search,
		// which is what keeps it close to free: the router resolves well inside
		// the upstream's own latency, so this call overlaps the search already in
		// flight instead of following it.
		const supplementing = classifying.then((route) =>
			route.intent === "discovery" && route.retrievalQuery
				? deps.upstream.search(route.retrievalQuery, { limit, signal })
				: null,
		);
		// A supplementary search is an improvement, never a dependency. If it
		// fails the query still has its primary candidates, and turning that into
		// a failed search would make discovery queries *less* reliable than the
		// ones that never asked for the extra work.
		const supplemented = supplementing.catch(() => null);

		const found = await searching;
		if (aborted()) return;

		const route = await classifying;
		const { intent } = route;
		yield { type: "intent", intent };

		if (found.provider === null) {
			// Every provider failed — distinct from every provider finding
			// nothing, and the trace should not conflate them.
			yield {
				type: "error",
				message: `No search provider answered. ${found.failures
					.map((failure) => failure.detail)
					.join("; ")}`,
			};
			return;
		}

		const extra = await supplemented;
		if (aborted()) return;

		const candidates = extra
			? interleave(extra.candidates, found.candidates, limit + DISCOVERY_EXTRA)
			: found.candidates;

		yield { type: "crawled", count: candidates.length };
		yield {
			type: "stage",
			stage: {
				id: "search",
				state: "done",
				label: candidates.length
					? `Searched ${candidates.length} sources`
					: "Searched the index — no candidates",
			},
		};

		if (candidates.length === 0) {
			yield {
				type: "stage",
				stage: { id: "compose", state: "done", label: "Nothing to read" },
			};
			yield { type: "done" };
			return;
		}

		yield {
			type: "stage",
			stage: { id: "read", state: "active", label: "Reading pages" },
		};

		/*
		  `revalidate` is the router's freshness verdict reaching the cache.

		  On the small class of queries whose answer moves within days — a current
		  version, a price, a standing — a seven-day-old cached page is a wrong
		  answer with a good response time, which is worse than a slow one. This
		  forces the conditional request rather than skipping the cache, so an
		  unchanged page still costs a 304 and no re-extraction. See
		  `RetrieveOptions.revalidate`.
		*/
		const { outcomes, stats } = await retrievePages(
			candidates.map((candidate) => candidate.url),
			{
				client: deps.egress,
				cache: deps.documents,
				revalidate: route.freshness === "high",
			},
		);
		if (aborted()) return;
		deps.onRetrieval?.(stats);

		const pages = outcomes.flatMap((outcome) =>
			outcome.ok ? [outcome.page] : [],
		);

		// Destinations, for a query that asked where to go. Emitted here rather
		// than after ranking because they do not depend on it — a place needs a
		// URL and a picture, not a passage — and this is a full rank plus a model
		// call earlier than the answer.
		if (intent === "discovery") {
			const places = placesFrom(
				candidates,
				outcomes,
				new Set(extra?.candidates.map((candidate) => candidate.url) ?? []),
			);
			if (places.length > 0) yield { type: "places", places };
		}

		yield {
			type: "stage",
			stage: {
				id: "read",
				state: "done",
				label: `Read ${stats.extracted} relevant page${stats.extracted === 1 ? "" : "s"}`,
			},
		};

		const passages = await selectPassages(query, pages, {
			limit: deps.passageLimit ?? DEFAULT_PASSAGES,
			// Turns on the recency multiplier in `applySignals`. On a normal query
			// it does nothing at all, which is the point: a date is only allowed to
			// reorder results when the query said dates matter.
			freshness: route.freshness,
		});
		if (aborted()) return;
		deps.onPassages?.(passages, pages);

		const sources = sourcesFrom(passages);

		/*
		  Two cheap things, both on domains we already have.

		  The read is one indexed statement for every source at once. The write
		  is `INSERT ... DO NOTHING`, which notes that these domains exist so the
		  probe job can look at them later — the opportunistic source PLAN.md
		  prefers, "weighted by what people actually search for, which beats any
		  static ranking list".

		  Neither fetches anything. A domain seen for the first time contributes
		  no chips to *this* answer and may contribute some to the next one.
		*/
		await attachCapabilities(sources, deps.capabilities);

		/*
		  Logged here, once we know which domains actually answered.

		  Not at the top of the pipeline, where only the query is known: the
		  demand signal PLAN.md wants is "what was asked *and* what answered it",
		  and a row written before retrieval could only ever hold half of it.

		  Deliberately not awaited. This is the one write in the request path
		  that no caller is waiting on, and putting a database round trip between
		  the sources and the first answer block would spend the latency the
		  event ordering exists to protect. It cannot reject — the store swallows
		  its own errors — so there is nothing to catch.
		*/
		void deps.queryLog?.record(
			query,
			sources.map((source) => source.domain),
		);

		// Before composition, always. This is property 1 above, and it is the
		// only place in the pipeline where the order is a decision rather than a
		// consequence.
		for (const source of sources) {
			yield { type: "source", source };
		}

		yield {
			type: "stage",
			stage: { id: "compose", state: "active", label: "Synthesizing answer" },
		};

		for await (const block of deps.composer.compose({
			query,
			passages,
			sources,
			intent,
			signal,
		})) {
			if (aborted()) return;
			yield { type: "block", block };
		}

		yield {
			type: "stage",
			stage: { id: "compose", state: "done", label: "Answer composed" },
		};
		yield { type: "done" };
	} catch (error) {
		if (aborted()) return;
		// Property 2. By the time anything here throws, the response has already
		// started and its status line is long gone.
		yield {
			type: "error",
			message: error instanceof Error ? error.message : String(error),
		};
	}
}
