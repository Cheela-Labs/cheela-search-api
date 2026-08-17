import { describe, expect, it } from "vitest";
import { chunkText } from "../../src/services/indexer/chunk.js";
import { extract } from "../../src/services/indexer/extract.js";
import { priorAuthority } from "../../src/services/indexer/index.js";
import {
	fromSigned,
	hammingDistance,
	isNearDuplicate,
	shingles,
	simhash,
	toSigned,
} from "../../src/services/indexer/simhash.js";

const TOKENS = 4; // characters per token, as chunk.ts estimates

const paragraph = (words: number, word = "sentence") =>
	`${Array.from({ length: words }, () => word).join(" ")}.`;

describe("chunking", () => {
	it("returns nothing for empty input", () => {
		expect(chunkText("")).toEqual([]);
		expect(chunkText("   \n\n  ")).toEqual([]);
	});

	it("keeps a short document as one chunk", () => {
		const chunks = chunkText("A short page about composting.");
		expect(chunks).toHaveLength(1);
		expect(chunks[0].ordinal).toBe(0);
	});

	it("stays inside the token ceiling", () => {
		const text = Array.from({ length: 40 }, () => paragraph(60)).join("\n\n");
		for (const chunk of chunkText(text)) {
			expect(chunk.text.length).toBeLessThanOrEqual(600 * TOKENS + 200);
		}
	});

	it("numbers chunks consecutively from zero", () => {
		const text = Array.from({ length: 30 }, () => paragraph(80)).join("\n\n");
		const chunks = chunkText(text);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.map((chunk) => chunk.ordinal)).toEqual(
			chunks.map((_, index) => index),
		);
	});

	it("overlaps consecutive chunks, so a fact on a boundary survives", () => {
		// This is the property the 20% overlap exists for: a sentence split
		// across two chunks is in neither chunk's embedding, and therefore
		// unfindable, unless one chunk contains it whole.
		const text = Array.from({ length: 20 }, (_, i) =>
			paragraph(70, `para${i}`),
		).join("\n\n");
		const chunks = chunkText(text);
		expect(chunks.length).toBeGreaterThan(1);

		const tail = chunks[0].text.split(/\s+/).slice(-5).join(" ");
		expect(chunks[1].text).toContain(tail.split(" ").at(-1) ?? "");
	});

	it("splits a wall of text with no blank lines", () => {
		// A page whose whole body is one paragraph still has to be chunked, or it
		// becomes a single chunk far past the embedder's window.
		const wall = Array.from({ length: 200 }, () => "Some sentence here.").join(
			" ",
		);
		expect(chunkText(wall).length).toBeGreaterThan(1);
	});
});

describe("simhash", () => {
	it("is zero for text with no features", () => {
		expect(simhash("")).toBe(0n);
	});

	it("is stable for the same text", () => {
		const text = "The quick brown fox jumps over the lazy dog repeatedly.";
		expect(simhash(text)).toBe(simhash(text));
	});

	it("keeps a small edit close, which is the whole point", () => {
		// An exact hash catches only byte-identical pages, and the duplicates that
		// actually fill an index are the same article with a different sidebar.
		const original = Array.from(
			{ length: 40 },
			(_, i) => `Sentence number ${i} about the same subject.`,
		).join(" ");
		const edited = `${original} One more trailing sentence.`;

		expect(
			hammingDistance(simhash(original), simhash(edited)),
		).toBeLessThanOrEqual(3);
		expect(isNearDuplicate(simhash(original), simhash(edited))).toBe(true);
	});

	it("keeps unrelated text far apart", () => {
		const a = simhash(
			"Composting turns kitchen scraps into soil. Layer green and brown material.",
		);
		const b = simhash(
			"The PlayStation 5 is a home video game console manufactured by Sony.",
		);
		expect(isNearDuplicate(a, b)).toBe(false);
		expect(hammingDistance(a, b)).toBeGreaterThan(10);
	});

	it("uses word order, not just vocabulary", () => {
		// Shingles rather than single words. Two documents with the same words in
		// a different order are different documents.
		expect(shingles("a b c d", 3)).toEqual(["a b c", "b c d"]);
	});

	it("survives the trip through a signed 64-bit column", () => {
		// Postgres has no unsigned bigint, so the value is stored signed. A reader
		// that treats it as a magnitude is wrong for half of all documents.
		for (const text of ["one", "two", "three", "a much longer document here"]) {
			const value = simhash(text);
			expect(fromSigned(toSigned(value))).toBe(value);
		}
	});
});

describe("extraction", () => {
	it("reads title, text and metadata from ordinary HTML", () => {
		const html = `<!doctype html><html lang="en"><head>
			<title>Composting for beginners</title>
			<meta property="og:image" content="/cover.png">
			<link rel="canonical" href="https://example.com/composting">
			<meta property="article:published_time" content="2024-03-01T10:00:00Z">
		</head><body><article>
			<h1>Composting for beginners</h1>
			<p>${paragraph(80)}</p>
			<p>${paragraph(80)}</p>
		</article></body></html>`;

		const result = extract(html, "https://example.com/composting?utm_source=x");
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.extraction.title).toContain("Composting");
		expect(result.extraction.text.length).toBeGreaterThan(200);
		expect(result.extraction.canonicalUrl).toBe(
			"https://example.com/composting",
		);
		// Relative og:image resolved against the page it came from.
		expect(result.extraction.image).toBe("https://example.com/cover.png");
		expect(result.extraction.language).toBe("en");
		expect(result.extraction.publishedAt).toBeGreaterThan(1_700_000_000 - 1e9);
	});

	it("refuses a JavaScript shell, and keeps its head", () => {
		// A storefront that renders its catalogue client-side. There is no text to
		// find and retrying will not produce any — but the `<head>` is complete,
		// and for a shopping query that is most of what a result card needs.
		const html = `<html><head>
			<title>Nike Air Jordan</title>
			<meta property="og:image" content="https://cdn.example.com/shoe.jpg">
		</head><body><div id="root"></div>
			<script src="a.js"></script><script src="b.js"></script>
			<script src="c.js"></script><script src="d.js"></script>
		</body></html>`;

		const result = extract(html, "https://shop.example.com/jordan");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("javascript-shell");
		expect(result.preview.title).toBe("Nike Air Jordan");
		expect(result.preview.image).toBe("https://cdn.example.com/shoe.jpg");
	});

	it("refuses content that is not HTML", () => {
		const result = extract(
			"%PDF-1.4",
			"https://example.com/a.pdf",
			"application/pdf",
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("not-html");
	});

	it("refuses a page too short to be worth indexing", () => {
		const result = extract(
			"<html><body><article><p>Too short.</p></article></body></html>",
			"https://example.com/x",
		);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(["too-short", "no-main-content"]).toContain(result.reason);
	});

	it("ignores an implausible published date rather than trusting it", () => {
		const html = `<html><head><title>T</title>
			<meta property="article:published_time" content="1970-01-01T00:00:00Z">
			</head><body><article><p>${paragraph(90)}</p><p>${paragraph(90)}</p></article></body></html>`;

		const result = extract(html, "https://example.com/x");
		expect(result.ok).toBe(true);
		// A date before the web existed is a parsing accident, and a document
		// dated 1970 is scored as maximally stale by every freshness function.
		if (result.ok) expect(result.extraction.publishedAt).toBeNull();
	});
});

describe("priorAuthority", () => {
	it("stays within bounds for anything", () => {
		for (const url of [
			"https://example.com",
			"http://a.gov",
			"https://x.edu/a/b/c/d/e/f/g",
			"not a url",
		]) {
			const value = priorAuthority(url);
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThanOrEqual(1);
		}
	});

	it("prefers institutional domains and penalises generated-looking URLs", () => {
		expect(priorAuthority("https://nasa.gov/report")).toBeGreaterThan(
			priorAuthority("https://example.com/report"),
		);
		expect(priorAuthority("https://example.com/a/b/c/d/e/f/g")).toBeLessThan(
			priorAuthority("https://example.com/a"),
		);
	});

	it("is neutral when it cannot tell", () => {
		expect(priorAuthority("not a url")).toBe(0.5);
	});
});
