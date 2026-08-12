import type { AnswerBlock } from "../../shared/events";
import { type ComposeInput, type Composer, citationNumbers } from "./types";

/**
 * Composes without a model, by quoting.
 *
 * This is the fallback, and it is deliberately not a synthesis: it emits the
 * best-matching passages verbatim, attributed, and says in the answer block
 * that it is doing so. Nothing here paraphrases, so nothing here can be wrong
 * about what a source said.
 *
 * Two jobs, both real:
 *
 * - **A degraded answer beats an error.** When the composer model is
 *   unconfigured, over budget, or down, a page of cited extracts is still worth
 *   reading. The alternative is an error frame on a query the retrieval stages
 *   answered perfectly well.
 * - **It makes the pipeline demonstrable without a model key.** Every stage
 *   before this one can be exercised end to end, which is how the event
 *   ordering and the surface's rendering got tested at all.
 *
 * It is not a good search answer and is not meant to read as one. The honesty
 * is the point: the failure mode this replaces is a composer that paraphrases
 * confidently from passages it did not have.
 */
export const extractiveComposer: Composer = {
	name: "extractive",

	async *compose(input: ComposeInput): AsyncIterable<AnswerBlock> {
		const numbers = citationNumbers(input.sources);

		if (input.passages.length === 0) {
			yield {
				kind: "answer",
				id: "answer",
				spans: [
					{
						kind: "text",
						text: "Nothing was retrieved for this query, so there is nothing to quote.",
					},
				],
			};
			return;
		}

		yield {
			kind: "answer",
			id: "answer",
			spans: [
				{
					kind: "text",
					text: "No composer model is configured, so this is not a written answer — below are the passages that best match, quoted exactly and attributed.",
				},
			],
		};

		// Three is enough to be useful and few enough to read. The ranking
		// already put the best first, and a wall of extracts is not more honest
		// than a short one, only longer.
		for (const [index, passage] of input.passages.slice(0, 3).entries()) {
			if (input.signal?.aborted) return;

			const n = numbers.get(passage.documentIndex);
			yield {
				kind: "note",
				id: `extract-${index}`,
				label: `FROM ${passage.domain.toUpperCase()}`,
				spans: [
					{ kind: "text", text: passage.text },
					...(n === undefined ? [] : ([{ kind: "cite", n }] as const)),
				],
			};
		}
	},
};
