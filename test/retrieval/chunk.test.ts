import { describe, expect, it } from "vitest";
import { chunkText } from "../../src/domain/retrieval/chunk";

const sentence = "Provisioned concurrency keeps a warm instance floor. ";
const paragraph = (times: number) => sentence.repeat(times).trim();

describe("chunkText", () => {
	it("returns nothing for empty input", () => {
		expect(chunkText("")).toEqual([]);
		expect(chunkText("   \n\n  ")).toEqual([]);
	});

	it("keeps a short document as one chunk", () => {
		const chunks = chunkText(`${paragraph(3)}\n\n${paragraph(3)}`);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.ordinal).toBe(0);
	});

	it("keeps whole paragraphs together rather than cutting at the budget", () => {
		const chunks = chunkText(
			[paragraph(10), paragraph(10), paragraph(10)].join("\n\n"),
			{ maxChars: 700, overlapChars: 0 },
		);

		expect(chunks.length).toBeGreaterThan(1);
		// A chunk boundary must fall between paragraphs, so no chunk ends in the
		// middle of a sentence that a reader would then see truncated.
		for (const chunk of chunks) {
			expect(chunk.text.trim().endsWith(".")).toBe(true);
		}
	});

	it("numbers chunks in document order", () => {
		const chunks = chunkText(
			Array.from({ length: 6 }, () => paragraph(8)).join("\n\n"),
			{ maxChars: 600 },
		);
		expect(chunks.map((chunk) => chunk.ordinal)).toEqual(
			chunks.map((_, index) => index),
		);
	});

	it("overlaps chunks so a claim spanning a boundary survives in one of them", () => {
		const chunks = chunkText([paragraph(9), paragraph(9)].join("\n\n"), {
			maxChars: 600,
			overlapChars: 120,
		});

		expect(chunks.length).toBeGreaterThan(1);
		const first = chunks[0] as { text: string };
		const second = chunks[1] as { text: string };
		// The head of the second chunk appears in the first — which is what
		// "overlap" has to mean for a claim on the boundary to survive whole in
		// one of them. Asserted this way round because the carry is cut at a word
		// boundary, so the two do not align on an exact character offset.
		expect(first.text).toContain(second.text.slice(0, 40));
	});

	it("cuts overlap at a word boundary, never mid-word", () => {
		const chunks = chunkText([paragraph(9), paragraph(9)].join("\n\n"), {
			maxChars: 600,
			overlapChars: 47,
		});
		const second = chunks[1] as { text: string };
		// A mid-word cut would leave a fragment; the first token must be a real
		// word from the source.
		const firstWord = second.text.split(/\s/)[0] as string;
		expect(sentence).toContain(firstWord.replace(/[.,]$/, ""));
	});

	it("splits a code block on lines, not on sentences", () => {
		const code = [
			"export default {",
			"  async fetch(request) {",
			"    const url = new URL(request.url);",
			"    return new Response(url.pathname);",
			"  },",
			"};",
		].join("\n");

		const chunks = chunkText(code, { maxChars: 60, overlapChars: 0 });

		// Every chunk is whole lines. A sentence split would cut after
		// "new URL(request.url)." and leave a fragment nobody can run or cite.
		for (const chunk of chunks) {
			for (const line of chunk.text.split("\n")) {
				expect(code.split("\n")).toContain(line);
			}
		}
	});

	it("bounds a single unsplittable run rather than emitting it whole", () => {
		// A minified bundle on one line: no sentences, no newlines, no boundary
		// to respect. It still must not become a 40 KB passage.
		const blob = "a".repeat(20_000);
		const chunks = chunkText(blob, { maxChars: 500, overlapChars: 0 });

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.text.length).toBeLessThanOrEqual(750);
		}
	});

	it("folds a short trailing fragment back rather than leaving it alone", () => {
		const chunks = chunkText(`${paragraph(12)}\n\nSee also.`, {
			maxChars: 700,
			overlapChars: 0,
			minChars: 120,
		});

		// "See also." on its own retrieves badly and cites worse.
		expect(chunks.at(-1)?.text.length).toBeGreaterThan(20);
		expect(chunks.at(-1)?.text).toContain("See also.");
		expect(chunks.at(-1)?.text.length).toBeGreaterThan("See also.".length);
	});

	it("hashes content, so the same passage in two documents embeds once", () => {
		const text = paragraph(6);
		const [a] = chunkText(text);
		const [b] = chunkText(text);
		expect(a?.contentHash).toBe(b?.contentHash);
		expect(a?.contentHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("gives different text different hashes", () => {
		const [a] = chunkText(paragraph(6));
		const [b] = chunkText(`${paragraph(6)} And one more.`);
		expect(a?.contentHash).not.toBe(b?.contentHash);
	});
});
