/**
 * Chunking, to the TDS's numbers: 300-600 tokens with 20% overlap.
 *
 * Tokens are estimated at four characters each rather than counted with a
 * tokeniser. The estimate is wrong by maybe 15% on English prose, and it is
 * the right trade: the exact count would need the model's tokeniser loaded in
 * this process for a number whose only job is to decide where to cut a
 * paragraph. Being 15% out moves a boundary; it does not lose text.
 *
 * The overlap is what stops a fact that straddles a boundary from being
 * unfindable — a sentence split across two chunks is in neither chunk's
 * embedding, and 20% is enough that it is whole in one of them.
 */

const CHARS_PER_TOKEN = 4;

export type ChunkOptions = {
	targetTokens?: number;
	maxTokens?: number;
	minTokens?: number;
	overlapRatio?: number;
};

export type Chunk = {
	ordinal: number;
	text: string;
};

/**
 * Splits on paragraph boundaries first, then sentences, and only then on
 * whitespace. Cutting mid-sentence produces a chunk that reads as a fragment
 * and embeds as one.
 */
function segments(text: string): string[] {
	const paragraphs = text
		.split(/\n\s*\n/)
		.map((entry) => entry.trim())
		.filter(Boolean);

	const out: string[] = [];
	for (const paragraph of paragraphs) {
		if (paragraph.length <= 2000) {
			out.push(paragraph);
			continue;
		}
		// A wall of text with no blank lines. Fall back to sentences.
		const sentences = paragraph.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g);
		if (sentences)
			out.push(...sentences.map((entry) => entry.trim()).filter(Boolean));
		else out.push(paragraph);
	}
	return out;
}

export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
	const target = (options.targetTokens ?? 450) * CHARS_PER_TOKEN;
	const max = (options.maxTokens ?? 600) * CHARS_PER_TOKEN;
	const min = (options.minTokens ?? 60) * CHARS_PER_TOKEN;
	const overlap = Math.floor(target * (options.overlapRatio ?? 0.2));

	const cleaned = text.replace(/\r\n/g, "\n").trim();
	if (!cleaned) return [];

	const pieces = segments(cleaned);
	const chunks: string[] = [];
	let current = "";

	for (const piece of pieces) {
		if (current && current.length + piece.length + 1 > max) {
			chunks.push(current);
			// Carry the tail of the finished chunk into the next one.
			const tail = current.slice(-overlap);
			const boundary = tail.search(/\s/);
			current = boundary === -1 ? "" : tail.slice(boundary + 1);
		}

		current = current ? `${current}\n${piece}` : piece;

		if (current.length >= target) {
			chunks.push(current);
			const tail = current.slice(-overlap);
			const boundary = tail.search(/\s/);
			current = boundary === -1 ? "" : tail.slice(boundary + 1);
		}
	}

	// The remainder, unless it is only the overlap we just carried over — that
	// would index the same sentences twice as a chunk of their own.
	if (current.trim().length >= min || (chunks.length === 0 && current.trim())) {
		chunks.push(current);
	}

	return chunks
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry, ordinal) => ({ ordinal, text: entry }));
}
