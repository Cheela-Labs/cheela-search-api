import type { Intent } from "../../shared/events";

/**
 * The part of routing that must happen before anything else, and needs no model.
 *
 * Only one intent has to be known *before* the upstream call: navigational. A
 * query that is already a URL does not need an index consulted to find the page
 * it names, and running the full pipeline for it costs eight upstream results,
 * eight page fetches, a rerank and a model call — roughly 2.6 seconds and real
 * money — to answer something that wanted one link.
 *
 * Everything else is classified in parallel with the upstream search (see
 * `classifier.ts`), where it costs nothing on the critical path. That split is
 * what keeps routing inside its 90 ms budget while still allowing a real model
 * to make the interesting decisions.
 *
 * This pass is deliberately conservative. It answers "is this literally an
 * address" and nothing else — no brand lists, no heuristics about what looks
 * like a company. A wrong navigational verdict is the expensive kind of wrong:
 * it skips retrieval entirely, so a misrouted informational query gets a link
 * instead of an answer.
 */

export type StructuralRoute =
	| { intent: "navigational"; url: string }
	| { intent: null };

/** Hostname-shaped: at least one dot, a plausible TLD, no spaces. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)*\.[a-z]{2,24}$/i;

/**
 * Things that look like hostnames and are not.
 *
 * `node.js` is the case that matters — it is a hostname by shape and a topic by
 * intent, and routing it navigationally would answer "where should I deploy a
 * Node.js API" with a link to a domain that does not exist. Extensions are the
 * general form of that mistake.
 */
const FILE_EXTENSION =
	/\.(js|ts|py|rb|go|rs|java|json|yaml|yml|md|txt|sh|css|html?|xml|toml|env|lock|sql|jsx|tsx)$/i;

export function routeStructurally(query: string): StructuralRoute {
	const trimmed = query.trim();

	// More than one token is a question, not an address, whatever it contains.
	if (!trimmed || /\s/.test(trimmed)) return { intent: null };

	if (/^https?:\/\//i.test(trimmed)) {
		try {
			const url = new URL(trimmed);
			if (url.protocol === "http:" || url.protocol === "https:") {
				return { intent: "navigational", url: url.toString() };
			}
		} catch {
			// Not a URL after all; fall through to the hostname check.
		}
		return { intent: null };
	}

	if (FILE_EXTENSION.test(trimmed)) return { intent: null };
	if (!HOSTNAME.test(trimmed)) return { intent: null };

	// A bare hostname. https, because a search engine sending people to http in
	// 2026 is doing them a disservice, and the redirect costs one hop if wrong.
	return { intent: "navigational", url: `https://${trimmed.toLowerCase()}/` };
}

/**
 * Whether an intent may skip retrieval.
 *
 * Only navigational does. Discovery and action both still need the web — the
 * difference they make is to how the answer is *composed*, not to whether pages
 * are read.
 */
export const skipsRetrieval = (intent: Intent): boolean =>
	intent === "navigational";
