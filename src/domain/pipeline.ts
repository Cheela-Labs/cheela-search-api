import type { EgressClient } from "../infra/egress/client";
import type { SearchRotation } from "../infra/upstream/rotation";
import type { SearchEvent } from "../shared/events";
import type { Composer } from "./compose/types";
import { sourcesFrom, swatchFor } from "./compose/types";
import { retrievePages } from "./retrieval/fetch";
import { selectPassages } from "./retrieval/rank";
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
	/** Candidate URLs requested from the upstream provider. */
	candidateLimit?: number;
	/** Passages kept for composition. */
	passageLimit?: number;
};

const DEFAULT_CANDIDATES = 8;
const DEFAULT_PASSAGES = 12;

/**
 * The navigational answer: the site, and nothing else.
 *
 * No upstream call, no fetch, no rerank, no model — roughly 350 ms and no cost,
 * against ~2.6 s and eight page fetches for a query that wanted one link. The
 * page is not read, so there is nothing to cite and nothing is claimed about
 * what it says.
 */
async function* navigational(url: string): AsyncGenerator<SearchEvent> {
	const { hostname } = new URL(url);

	yield {
		type: "stage",
		stage: { id: "route", state: "done", label: `Going to ${hostname}` },
	};
	yield { type: "crawled", count: 0 };
	yield {
		type: "source",
		source: {
			id: "nav",
			n: 1,
			domain: hostname,
			path: hostname,
			url,
			title: hostname,
			swatch: swatchFor(hostname),
			passages: [],
		},
	};
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
			yield* navigational(structural.url);
			return;
		}

		// Classification runs *concurrently* with the upstream call rather than
		// ahead of it. The verdict is needed at composition, not at retrieval —
		// every remaining intent reads the same pages — so a classifier that
		// resolves inside the search's own 500–1700 ms costs nothing at all.
		// Awaiting it first would add its full latency to every query.
		const classifying = deps.classifier(query, signal);

		const found = await deps.upstream.search(query, {
			limit: deps.candidateLimit ?? DEFAULT_CANDIDATES,
			signal,
		});
		if (aborted()) return;

		const intent = await classifying;
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

		yield { type: "crawled", count: found.candidates.length };
		yield {
			type: "stage",
			stage: {
				id: "search",
				state: "done",
				label: found.candidates.length
					? `Searched ${found.candidates.length} sources`
					: "Searched the index — no candidates",
			},
		};

		if (found.candidates.length === 0) {
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

		const { outcomes, stats } = await retrievePages(
			found.candidates.map((candidate) => candidate.url),
			{ client: deps.egress },
		);
		if (aborted()) return;

		const pages = outcomes.flatMap((outcome) =>
			outcome.ok ? [outcome.page] : [],
		);

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
		});
		if (aborted()) return;

		const sources = sourcesFrom(passages);

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
