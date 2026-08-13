import type { AnswerBlock, Intent, Source } from "../../shared/events";
import type { Passage } from "../retrieval/rank";

/** One retrieved document, with the citation number the answer refers to it by. */
export type CitedSource = Source & { documentIndex: number };

export type ComposeInput = {
	query: string;
	/**
	 * What the router decided. Composition is where intent actually changes the
	 * output — the label alone is worth nothing to a reader.
	 */
	intent?: Intent;
	/** Ranked, best first. Each carries the `documentIndex` its source has. */
	passages: readonly Passage[];
	sources: readonly CitedSource[];
	signal?: AbortSignal;
};

/**
 * Turns ranked passages into answer blocks.
 *
 * An async iterable rather than a promise, because the surface builds the
 * answer upward as blocks arrive and a composer that returns everything at once
 * throws that away. A composer with one block still satisfies it.
 */
export type Composer = {
	readonly name: string;
	compose(input: ComposeInput): AsyncIterable<AnswerBlock>;
};

/**
 * A stable colour per host, standing in for a favicon.
 *
 * Real favicons are a third-party image request per result — a tracking surface
 * and a layout-shift source on the one screen that should feel fast. A hue
 * derived from the host is neither, and it is stable across queries, which is
 * what makes it useful as recognition rather than decoration.
 */
export function swatchFor(domain: string): string {
	let hash = 0;
	for (let index = 0; index < domain.length; index += 1) {
		hash = (hash * 31 + domain.charCodeAt(index)) | 0;
	}
	// Saturation and lightness fixed so every swatch sits at the same weight
	// against the surface's paper background; only hue varies.
	return `hsl(${Math.abs(hash) % 360} 62% 58%)`;
}

/**
 * Builds the source list the answer cites, numbered in the order the ranked
 * passages first mention each document.
 *
 * Numbered by *appearance in the ranking* rather than by upstream position:
 * `[1]` should be the source the answer leans on hardest, and the upstream
 * provider's ordering is about the query, not about what we ended up citing.
 */
export function sourcesFrom(passages: readonly Passage[]): CitedSource[] {
	const byDocument = new Map<number, CitedSource>();

	for (const passage of passages) {
		const existing = byDocument.get(passage.documentIndex);
		if (existing) {
			existing.passages.push({
				id: `${passage.documentIndex}-${passage.ordinal}`,
				text: passage.text,
				cited: true,
			});
			continue;
		}

		let path = passage.domain;
		try {
			const url = new URL(passage.url);
			path = `${url.hostname}${url.pathname}`.replace(/\/$/, "");
		} catch {
			// A URL that will not parse has already been through the egress
			// client, so this is unreachable in practice — the fallback keeps it
			// from being fatal if that ever stops being true.
		}

		byDocument.set(passage.documentIndex, {
			id: `doc-${passage.documentIndex}`,
			n: byDocument.size + 1,
			domain: passage.domain,
			path,
			url: passage.url,
			title: passage.title ?? passage.domain,
			swatch: swatchFor(passage.domain),
			documentIndex: passage.documentIndex,
			passages: [
				{
					id: `${passage.documentIndex}-${passage.ordinal}`,
					text: passage.text,
					cited: true,
				},
			],
		});
	}

	return [...byDocument.values()];
}

/** Maps a passage to the citation number its source was given. */
export function citationNumbers(
	sources: readonly CitedSource[],
): Map<number, number> {
	return new Map(sources.map((source) => [source.documentIndex, source.n]));
}

export type { AnswerBlock };
