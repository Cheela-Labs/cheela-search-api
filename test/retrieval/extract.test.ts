import { describe, expect, it } from "vitest";
import { extract } from "../../src/domain/retrieval/extract";
import { fixtures, shouldExtract, shouldRefuse } from "./fixtures";

/**
 * The acceptance criterion for step 4 of PLAN.md: extraction success rate above
 * 0.90 on a fixture set, measured rather than eyeballed.
 *
 * The rate alone is a weak number — a set somebody designed to pass will pass —
 * so the per-shape assertions below carry most of the weight. Each one requires
 * the article's sentinel to survive *and* the chrome's to be gone, which an
 * extractor returning a nav bar fails even though it "succeeded".
 */

const GATE = 0.9;

describe("extract · shapes that must yield an article", () => {
	for (const fixture of shouldExtract) {
		it(fixture.name, () => {
			const result = extract(fixture.html, fixture.url);

			if (!result.ok) {
				throw new Error(`refused as ${result.reason}: ${result.detail}`);
			}

			for (const needle of fixture.mustContain ?? []) {
				expect(
					result.extraction.text,
					`lost "${needle}" — the article did not survive`,
				).toContain(needle);
			}
			for (const needle of fixture.mustNotContain ?? []) {
				expect(
					result.extraction.text,
					`kept "${needle}" — chrome leaked into the article`,
				).not.toContain(needle);
			}
		});
	}
});

describe("extract · shapes that must be refused, by name", () => {
	for (const fixture of shouldRefuse) {
		it(`${fixture.name} → ${fixture.expect}`, () => {
			const result = extract(fixture.html, fixture.url);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe(fixture.expect);
		});
	}
});

describe("extract · the measured rate", () => {
	it(`clears ${GATE} across the fixture set`, () => {
		const results = shouldExtract.map((fixture) => ({
			name: fixture.name,
			result: extract(fixture.html, fixture.url),
		}));

		const failed = results.filter(({ result }) => !result.ok);
		const rate = (results.length - failed.length) / results.length;

		expect(
			rate,
			`failed: ${failed
				.map(({ name, result }) =>
					result.ok ? name : `${name} (${result.reason})`,
				)
				.join(", ")}`,
		).toBeGreaterThan(GATE);
	});

	it("reports every fixture as exactly one outcome", () => {
		// No shape may be ambiguous — a page that sometimes extracts and
		// sometimes does not is the hardest kind of corpus bug to chase.
		for (const fixture of fixtures) {
			const first = extract(fixture.html, fixture.url);
			const second = extract(fixture.html, fixture.url);
			expect(first.ok).toBe(second.ok);
			if (first.ok && second.ok) {
				expect(first.extraction.contentHash).toBe(
					second.extraction.contentHash,
				);
			}
		}
	});
});

describe("extract · details that downstream depends on", () => {
	it("resolves rel=canonical, so two URLs for one page become one document", () => {
		const fixture = shouldExtract.find((f) =>
			f.name.includes("canonical"),
		) as (typeof shouldExtract)[number];

		const result = extract(fixture.html, fixture.url);
		expect(result.ok).toBe(true);
		if (result.ok) {
			// The schema's unique constraint is on canonical_url; if this returned
			// the requested URL, the tracking parameter would create a duplicate.
			expect(result.extraction.canonicalUrl).toBe(
				"https://example.test/posts/original",
			);
		}
	});

	it("falls back to the fetched URL when there is no canonical", () => {
		const fixture = shouldExtract[0] as (typeof shouldExtract)[number];
		const result = extract(fixture.html, fixture.url);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.extraction.canonicalUrl).toBe(fixture.url);
	});

	it("hashes the text, not the markup", () => {
		const article = `<article><h1>H</h1><p>${"Body sentence that is long enough to clear the minimum. ".repeat(6)}</p></article>`;
		const plain = extract(
			`<html><body>${article}</body></html>`,
			"https://a.test/",
		);
		const withAd = extract(
			`<html><body>${article}<div class="ad">buy this</div></body></html>`,
			"https://a.test/",
		);

		expect(plain.ok && withAd.ok).toBe(true);
		if (plain.ok && withAd.ok) {
			// Two fetches of a page whose only change was an ad slot must hash the
			// same, or the embedding cache re-embeds the whole corpus on every
			// crawl.
			expect(withAd.extraction.contentHash).toBe(plain.extraction.contentHash);
		}
	});

	it("refuses a content type it does not read, before parsing it", () => {
		const result = extract("%PDF-1.7 binary junk", "https://a.test/x.pdf", {
			contentType: "application/pdf",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("not-html");
	});

	it("separates blocks, so chunking has something to split on", () => {
		const result = extract(
			`<html><body><article><h1>Title</h1><p>${"First paragraph sentence here. ".repeat(8)}</p><p>${"Second paragraph sentence here. ".repeat(8)}</p></article></body></html>`,
			"https://a.test/",
		);
		expect(result.ok).toBe(true);
		// textContent would run these together into one line.
		if (result.ok) expect(result.extraction.text).toContain("\n");
	});
});
