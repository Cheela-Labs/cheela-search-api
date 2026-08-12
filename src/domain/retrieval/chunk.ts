import { createHash } from "node:crypto";

/**
 * Splits an extracted document into retrieval units.
 *
 * ## The unit is a passage, and its size is a retrieval decision
 *
 * Too small and a chunk loses the context that made it an answer — a sentence
 * saying "it does not" needs the one before it. Too large and the reranker
 * scores a whole section on one relevant line, then the composer is handed
 * mostly irrelevant text and cites it. The target below is about 300 tokens,
 * which is the range most retrieval work lands on for prose, with an overlap so
 * that a claim spanning a boundary is still whole in one of the two chunks.
 *
 * ## Sized in characters, not tokens
 *
 * A tokenizer is a model-specific dependency and a per-chunk cost, and it would
 * buy precision this does not need: the budget is a heuristic either way, and
 * ~4 characters per token is close enough for English prose that the difference
 * never changes a chunk boundary that mattered. Revisit if the corpus stops
 * being mostly English, where that ratio is wrong in both directions.
 *
 * ## Block boundaries come from extraction, and are load-bearing
 *
 * `extract()` serialises with blank lines between blocks precisely so this can
 * split on them. Paragraphs are kept whole wherever they fit, so a chunk is a
 * run of complete paragraphs rather than an arbitrary window — which is what
 * makes a cited passage readable when the surface shows it to somebody.
 */

export type Chunk = {
	/** Position in the document. Matches `web.passages.ordinal`. */
	ordinal: number;
	text: string;
	/** With a model version, the embedding cache key. Matches the schema. */
	contentHash: string;
};

export type ChunkOptions = {
	/** Soft ceiling. A block that cannot be split lands over it rather than mangled. */
	maxChars?: number;
	/** Carried from the end of the previous chunk. Zero disables overlap. */
	overlapChars?: number;
	/** Below this, a trailing fragment is folded back rather than kept alone. */
	minChars?: number;
};

const DEFAULT_MAX = 1_200;
const DEFAULT_OVERLAP = 200;
const DEFAULT_MIN = 120;

/**
 * Sentence boundaries, approximately.
 *
 * Deliberately naive: it splits after `.`, `!` or `?` followed by whitespace.
 * It will split "e.g. this" and won't split a missing full stop, and neither
 * matters — this only runs on a paragraph already too long to keep whole, where
 * the alternative is a hard cut mid-word. A real sentence segmenter is a
 * dependency and a language model's worth of edge cases for a tie-break.
 */
const SENTENCE = /(?<=[.!?])\s+/;

const hash = (text: string): string =>
	createHash("sha256").update(text).digest("hex");

/**
 * Splits one oversized block.
 *
 * On lines when the block has internal newlines — that is what a code sample
 * looks like after extraction, since `<pre>` keeps its newlines and prose does
 * not. Cutting code on sentence boundaries produces fragments that are wrong to
 * cite and useless to read.
 */
function splitBlock(block: string, maxChars: number): string[] {
	const looksLikeCode = block.includes("\n");
	const parts = looksLikeCode ? block.split("\n") : block.split(SENTENCE);

	const out: string[] = [];
	let current = "";

	for (const part of parts) {
		const joiner = current ? (looksLikeCode ? "\n" : " ") : "";
		if (current && current.length + joiner.length + part.length > maxChars) {
			out.push(current);
			current = part;
			continue;
		}
		current += joiner + part;

		// A single part longer than the budget has nowhere left to be split
		// sensibly. Cut it on the budget rather than emit something unbounded —
		// a 40 KB minified line is not a passage, and carrying it whole would
		// blow every downstream limit.
		while (current.length > maxChars * 1.5) {
			out.push(current.slice(0, maxChars));
			current = current.slice(maxChars);
		}
	}

	if (current) out.push(current);
	return out;
}

/** The tail of a chunk, cut at a boundary rather than mid-word. */
function tailOf(text: string, chars: number): string {
	// Zero means no overlap. Returning `text` here — as this did — makes every
	// chunk carry the whole of its predecessor, and chunk lengths grow linearly
	// through the document: 500, 1002, 1504, and so on to the entire page in one
	// passage. It fails silently, because each chunk is individually plausible.
	if (chars <= 0) return "";
	if (text.length <= chars) return text;
	const tail = text.slice(-chars);
	const boundary = tail.search(/\s/);
	return boundary === -1 ? tail : tail.slice(boundary + 1);
}

export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
	const maxChars = options.maxChars ?? DEFAULT_MAX;
	const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP;
	const minChars = options.minChars ?? DEFAULT_MIN;

	const blocks = text
		.split(/\n{2,}/)
		.map((block) => block.trim())
		.filter(Boolean);

	if (blocks.length === 0) return [];

	// Every block, at or under the budget. `atomic` marks a piece that came from
	// splitting an oversized block: those are never merged with anything, because
	// the merge would join them with a blank line and a code sample reassembled
	// with blank lines between its statements is not the code any more.
	const units: { text: string; atomic: boolean }[] = [];
	for (const block of blocks) {
		if (block.length <= maxChars) {
			units.push({ text: block, atomic: false });
		} else {
			for (const part of splitBlock(block, maxChars)) {
				units.push({ text: part, atomic: true });
			}
		}
	}

	// Atomicity travels with each emitted chunk, because the trailing-fragment
	// fold below has to know whether it is joining prose or code.
	const texts: { text: string; atomic: boolean }[] = [];
	let current = "";
	let currentAtomic = false;

	for (const unit of units) {
		if (!current) {
			current = unit.text;
			currentAtomic = unit.atomic;
			continue;
		}
		if (
			!unit.atomic &&
			!currentAtomic &&
			current.length + 2 + unit.text.length <= maxChars
		) {
			current += `\n\n${unit.text}`;
			continue;
		}
		texts.push({ text: current, atomic: currentAtomic });
		// Overlap is prepended to the next chunk rather than appended to this
		// one, so the duplicated text reads as lead-in context instead of a
		// repeated ending.
		// No lead-in onto an atomic piece either: prepending prose to a code
		// fragment changes what it is.
		const carry = unit.atomic ? "" : tailOf(current, overlapChars);
		current = carry ? `${carry}\n\n${unit.text}` : unit.text;
		currentAtomic = unit.atomic;
	}
	if (current) texts.push({ text: current, atomic: currentAtomic });

	// A short trailing chunk is usually a heading or a sign-off that was left
	// over. On its own it retrieves badly and cites worse; folded back it is
	// context for the chunk it belonged to.
	if (texts.length > 1) {
		const last = texts[texts.length - 1] as { text: string; atomic: boolean };
		const previous = texts[texts.length - 2] as {
			text: string;
			atomic: boolean;
		};
		// Never across an atomic boundary: folding a two-character `};` back into
		// the previous chunk with a blank line between them reassembles the code
		// wrong, which is worse than the stray fragment this is here to avoid.
		const foldable = !last.atomic && !previous.atomic;
		if (
			foldable &&
			last.text.length < minChars &&
			previous.text.length + last.text.length <= maxChars * 1.5
		) {
			texts.splice(texts.length - 2, 2, {
				text: `${previous.text}\n\n${last.text}`,
				atomic: false,
			});
		}
	}

	return texts.map((chunk, index) => ({
		ordinal: index,
		text: chunk.text,
		contentHash: hash(chunk.text),
	}));
}
