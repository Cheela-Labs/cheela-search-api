import type { TextModel } from "../../infra/model/types";
import type { Intent } from "../../shared/events";

/**
 * Classifies a query's intent with a model, off the critical path.
 *
 * ## Why this is free
 *
 * It runs concurrently with the upstream search, which takes 500–1700 ms
 * anyway. The verdict is needed at composition, not at retrieval — every intent
 * except navigational reads the same pages — so a classification that resolves
 * inside the search's own latency costs nothing at all. Doing it *before* the
 * search, which is the obvious way, would add its full latency to every query.
 *
 * ## Ambiguity resolves downward, always
 *
 * A model that is unsure answers `informational`, and a model that fails or
 * times out is treated as `informational` rather than retried. Getting this
 * backwards is how a search engine starts taking actions nobody asked for:
 * surfacing an action that was not wanted costs a chip nobody clicks, while
 * taking one costs a great deal. The whole gradient runs toward showing.
 *
 * Note that `action` is *never* returned here even when the query plainly asks
 * for one. There is no invoker yet, and a route to a capability that cannot be
 * called is a route to a dead end — so the highest this classifier will go is
 * `discovery`, which is the "show what this site can do" row. When Phase 2
 * lands, this is the one line that changes.
 */

const SYSTEM = `You label a web search query with one intent. Answer with a single word and nothing else.

navigational — the user wants one specific site or page. A brand or product name alone, a company name, an app name.
discovery — the user wants to do or obtain something: buy, book, download, sign up, find a place, compare products to purchase.
informational — the user wants to know something: how, why, what, comparisons for understanding, documentation, news, definitions.

Examples:
"nike jordans" -> discovery
"nike" -> navigational
"why are jordans expensive" -> informational
"book a table near me" -> discovery
"how do refunds work at stripe" -> informational
"stripe dashboard" -> navigational
"best laptop for video editing" -> discovery
"how does a cpu work" -> informational

Answer with exactly one of: navigational, discovery, informational`;

/** What a model may return. `action` is deliberately not reachable — see above. */
const ALLOWED = new Set<Intent>(["navigational", "discovery", "informational"]);

export type Classifier = (
	query: string,
	signal?: AbortSignal,
) => Promise<Intent>;

export function createClassifier(model: TextModel): Classifier {
	return async (query, signal) => {
		try {
			const raw = await model.complete({
				system: SYSTEM,
				user: query,
				signal,
			});

			// Models answer "discovery." and "**discovery**" and "Intent:
			// discovery" as readily as "discovery". Take the first word that is a
			// label rather than requiring the whole reply to be one.
			const word = raw
				.toLowerCase()
				.split(/[^a-z]+/)
				.find((token) => ALLOWED.has(token as Intent));

			return (word as Intent | undefined) ?? "informational";
		} catch {
			// A classifier that fails must not fail the query. Informational is the
			// safe answer and also the most common one, so the cost of being wrong
			// here is a normal cited answer.
			return "informational";
		}
	};
}

/** Used when no model is configured: every query is informational. */
export const alwaysInformational: Classifier = async () => "informational";
