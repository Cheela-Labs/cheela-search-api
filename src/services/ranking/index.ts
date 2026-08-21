import { createHash } from "node:crypto";
import type { Intent } from "../../contracts/intent.js";
import {
	type CapabilityHit,
	type CapabilityRef,
	type Passage,
	type Result,
	swatchFor,
} from "../../contracts/search.js";
import type {
	IndexedCapability,
	RetrievedDocument,
} from "../retriever/index.js";

/**
 * The Ranking Engine's application half.
 *
 * Most of the ranking already happened in Vespa, where the seven-term formula
 * and the cross-encoder live — that is the right place for it, next to the
 * data. What is left here is what Vespa cannot do: merge two result sets that
 * came from different systems, decide which passages of a document are the
 * ones worth showing, and decide whether a capability has earned a place among
 * the web results.
 */

/** Stable across requests, so a client can cache or diff on it. */
function idFor(url: string): string {
	return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/**
 * Picks the passages that answer the query.
 *
 * A whole document is too much to show and its first paragraph is often
 * navigation. This scores each chunk on term overlap with the query and keeps
 * the best few — the same job the cross-encoder did for documents, done
 * cheaply for chunks because there are far more of them and they are already
 * in memory.
 */
export function selectPassages(
	query: string,
	document: RetrievedDocument,
	limit = 3,
): Passage[] {
	const wanted = new Set(
		query
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((word) => word.length > 2),
	);

	const scored = document.chunks.map((chunk, index) => {
		const words = chunk.toLowerCase().split(/[^a-z0-9]+/);
		let hits = 0;
		for (const word of words) if (wanted.has(word)) hits += 1;
		return {
			index,
			chunk,
			// Divided by length so a long chunk does not win on volume alone.
			score: words.length === 0 ? 0 : hits / Math.sqrt(words.length),
		};
	});

	return (
		scored
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			// Back into document order: passages read as a summary when they are in
			// the order the author wrote them, and as noise when they are not.
			.sort((a, b) => a.index - b.index)
			.map((entry) => ({
				id: `${idFor(document.url)}-${entry.index}`,
				text: entry.chunk,
				// Set later, once the generator has said what it actually cited.
				cited: false,
			}))
	);
}

export function toResult(
	query: string,
	document: RetrievedDocument,
	capabilities: CapabilityRef[] = [],
): Result {
	return {
		id: idFor(document.url),
		url: document.url,
		domain: document.domain,
		path: document.path,
		title: document.title || document.domain,
		snippet: document.snippet,
		image: document.image,
		authority: document.authority,
		// Reported as the decayed value the ranking used, not as a raw date,
		// so a client can sort on it without knowing the decay.
		freshness: document.features.freshness_score ?? 0.5,
		publishedAt: document.publishedAt || undefined,
		swatch: swatchFor(document.domain),
		passages: selectPassages(query, document),
		capabilities: capabilities.length > 0 ? capabilities : undefined,
		source: document.origin,
		// Both omitted rather than sent empty. A surface that reads `structured`
		// as "this page published nothing" and `undefined` as "we did not look"
		// can tell an unmarked page from an external result; two empty arrays
		// cannot say which happened.
		structured:
			document.structured.length > 0 ? document.structured : undefined,
		description: document.description || undefined,
		// Capped here rather than at the index: a long page has a hundred of
		// these and a card shows six.
		headings:
			document.headings.length > 0 ? document.headings.slice(0, 12) : undefined,
	};
}

/**
 * Which capabilities are shown.
 *
 * Capabilities compete with web pages during ranking — in Vespa, where they
 * are scored by the same formula on the same scale. What is decided here is
 * narrower: how many to surface, and whether to surface any at all. An
 * information query that happens to be near a calendar action should not get a
 * button, and a `min` on the score is what stops that.
 */
export function selectCapabilities(
	capabilities: IndexedCapability[],
	intent: Intent,
	topDocumentScore: number,
): CapabilityHit[] {
	const wantsAction =
		intent === "action" ||
		intent === "utility" ||
		intent === "shopping" ||
		intent === "travel";

	// A capability has to beat a real result, not merely exist. On an action
	// query the bar is lower because the user asked for one.
	const floor = wantsAction ? topDocumentScore * 0.4 : topDocumentScore * 1.1;

	return capabilities
		.filter((capability) => capability.score >= floor)
		.slice(0, wantsAction ? 5 : 2)
		.map((capability) => ({
			id: capability.capId,
			domain: capability.domain,
			invocationName: capability.invocationName,
			title: capability.title,
			description: capability.description,
			provider: capability.provider,
			auth: capability.auth,
			effects: (capability.effects as CapabilityHit["effects"]) ?? "unknown",
			callable: capability.callable,
			score: capability.score,
		}));
}

/** Marks the passages the generator actually cited, for the surface to highlight. */
export function markCited(results: Result[], citedIds: Set<string>): Result[] {
	return results.map((result) =>
		citedIds.has(result.id)
			? {
					...result,
					passages: result.passages.map((passage) => ({
						...passage,
						cited: true,
					})),
				}
			: result,
	);
}
