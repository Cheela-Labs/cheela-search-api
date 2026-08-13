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
 *
 * ## Why it also writes a retrieval query
 *
 * Labelling "nike jordans" as discovery and then searching for "nike jordans"
 * gets Wikipedia's Air Jordan article and a sneaker blog — measured, not
 * supposed. The label was right and it changed nothing, because the index was
 * asked the same question either way. What the reader wanted was somewhere to
 * buy them, and that is a different search.
 *
 * So the model returns both: the intent, and — for discovery only — the query
 * that would actually find places rather than explanations. It costs no extra
 * call, since the model has already read the query, and it is the difference
 * between the intent being a label and the intent being an answer.
 */

const SYSTEM = `You label a web search query with one intent, and for discovery you also rewrite it.

navigational — the user wants one specific site or page. A brand or product name alone, a company name, an app name.
discovery — the user wants to do or obtain something: buy, book, download, sign up, find a place, compare products to purchase.
informational — the user wants to know something: how, why, what, comparisons for understanding, documentation, news, definitions.

For discovery, answer "discovery | <query>" where <query> is a web search that finds places to obtain or do the thing — shops, booking pages, listings — not articles about it. Keep the user's own product, brand and place words. Do not invent a location the user did not give.
For anything else, answer the single word.

Examples:
"nike jordans" -> discovery | buy nike jordan sneakers online store
"nike" -> navigational
"why are jordans expensive" -> informational
"book a table near me" -> discovery | restaurant reservation booking near me
"how do refunds work at stripe" -> informational
"stripe dashboard" -> navigational
"best laptop for video editing" -> discovery | buy laptop for video editing online store
"how does a cpu work" -> informational
"cheap flights to goa" -> discovery | book flights to goa fares

Answer on one line and nothing else.`;

/** What a model may return. `action` is deliberately not reachable — see above. */
const ALLOWED = new Set<Intent>(["navigational", "discovery", "informational"]);

/**
 * Long enough for a rewritten query, short enough that the model cannot use this
 * field as a channel. Its content becomes a search string and nothing else — it
 * is never fetched, never executed, never shown to the reader — but a bound is
 * cheap and an unbounded string echoed from a model that just read untrusted
 * input is a habit worth not having.
 */
const MAX_RETRIEVAL_QUERY = 120;

export type Route = {
	intent: Intent;
	/**
	 * A search that finds places rather than explanations. Non-null only for
	 * discovery, and even then only when the model offered one — the caller must
	 * treat its absence as "search what the user typed".
	 */
	retrievalQuery: string | null;
};

export type Classifier = (
	query: string,
	signal?: AbortSignal,
) => Promise<Route>;

/** Every failure path lands here. See "ambiguity resolves downward" above. */
const INFORMATIONAL: Route = { intent: "informational", retrievalQuery: null };

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

			if (word === undefined) return INFORMATIONAL;
			const intent = word as Intent;
			if (intent !== "discovery") return { intent, retrievalQuery: null };

			// Everything after the first pipe, collapsed to one line. A model that
			// ignored the format simply does not get a rewrite, and the pipeline
			// falls back to the query the user typed.
			const rewritten = raw
				.slice(raw.indexOf("|") + 1)
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, MAX_RETRIEVAL_QUERY);

			return {
				intent,
				retrievalQuery:
					raw.includes("|") && rewritten.length > 0 ? rewritten : null,
			};
		} catch {
			// A classifier that fails must not fail the query. Informational is the
			// safe answer and also the most common one, so the cost of being wrong
			// here is a normal cited answer.
			return INFORMATIONAL;
		}
	};
}

/** Used when no model is configured: every query is informational. */
export const alwaysInformational: Classifier = async () => INFORMATIONAL;
