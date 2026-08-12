import type { EgressClient } from "../infra/egress/client";
import type { SearchRotation } from "../infra/upstream/rotation";
import type { SearchEvent } from "../shared/events";
import type { Composer } from "./compose/types";
import { sourcesFrom } from "./compose/types";
import { retrievePages } from "./retrieval/fetch";
import { selectPassages } from "./retrieval/rank";

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
	/** Candidate URLs requested from the upstream provider. */
	candidateLimit?: number;
	/** Passages kept for composition. */
	passageLimit?: number;
};

const DEFAULT_CANDIDATES = 8;
const DEFAULT_PASSAGES = 12;

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

		// Phase 0 has no router; every query is informational. Emitted anyway so
		// the surface's handling of the field is exercised from the first day
		// rather than the day routing arrives.
		yield { type: "intent", intent: "informational" };

		const found = await deps.upstream.search(query, {
			limit: deps.candidateLimit ?? DEFAULT_CANDIDATES,
			signal,
		});
		if (aborted()) return;

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
