import type { Span } from "../../shared/events";

/**
 * Turns `"Workers have no cold start [1][3]."` into the span sequence the
 * surface renders.
 *
 * ## Unknown citation numbers are dropped, not rendered
 *
 * A model asked to cite will sometimes cite a source that is not there — a
 * number past the end of the list, or `[0]`. Passing that through gives the
 * surface a citation chip that opens nothing, which is worse than an uncited
 * sentence: an uncited sentence looks unsupported, a broken citation looks
 * supported and is not.
 *
 * The text around a dropped citation is kept. The claim may well be right; it
 * is the attribution that was invented.
 */

/** `[1]`, `[1,2]`, `[1, 2, 3]` — all three forms models actually produce. */
const CITATION = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

export function toSpans(text: string, sourceCount: number): Span[] {
	const spans: Span[] = [];
	let cursor = 0;
	const seenInThisRun = new Set<number>();

	const pushText = (value: string): void => {
		if (!value) return;
		const last = spans[spans.length - 1];
		// Merged with the preceding run so a dropped citation does not leave two
		// adjacent text spans that render with a seam between them.
		if (last?.kind === "text") last.text += value;
		else spans.push({ kind: "text", text: value });
	};

	CITATION.lastIndex = 0;
	let match = CITATION.exec(text);
	while (match !== null) {
		pushText(text.slice(cursor, match.index));
		cursor = match.index + match[0].length;

		const numbers = (match[1] as string)
			.split(",")
			.map((part) => Number.parseInt(part.trim(), 10));

		let anyKept = false;
		for (const n of numbers) {
			if (!Number.isInteger(n) || n < 1 || n > sourceCount) continue;
			// `[1][1]` in one breath is one citation. The surface renders each as a
			// chip, and two identical chips side by side is noise.
			if (seenInThisRun.has(n)) continue;
			seenInThisRun.add(n);
			spans.push({ kind: "cite", n });
			anyKept = true;
		}
		if (!anyKept) {
			// Every number in this bracket was invented. Nothing is emitted, and
			// the surrounding text closes over the gap.
		}

		match = CITATION.exec(text);
	}

	pushText(text.slice(cursor));

	// A citation run is per adjacent group, not per block: two sentences may
	// legitimately both cite [1].
	return spans.filter((span) => span.kind === "cite" || span.text.length > 0);
}

/**
 * Splits a labelled composer output into sections.
 *
 * The model is asked for `LABEL: text` lines because that maps onto the block
 * types the surface already renders, and because a model asked for JSON returns
 * prose wrapped in JSON roughly as often as it returns JSON. A malformed
 * section degrades to one answer block rather than to nothing.
 */
export function splitSections(
	raw: string,
	allowed: readonly string[],
): { label: string; text: string }[] {
	const pattern = new RegExp(`^\\s*(${allowed.join("|")})\\s*:\\s*`, "im");
	const lines = raw.split("\n");

	const sections: { label: string; text: string }[] = [];
	let current: { label: string; text: string } | null = null;

	for (const line of lines) {
		const match = line.match(pattern);
		if (match) {
			if (current) sections.push(current);
			current = {
				label: (match[1] as string).toUpperCase(),
				text: line.slice(match[0].length),
			};
			continue;
		}
		if (current) current.text += `\n${line}`;
	}
	if (current) sections.push(current);

	return sections
		.map((section) => ({ ...section, text: section.text.trim() }))
		.filter((section) => section.text.length > 0);
}
