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

/**
 * The image is what a shopping result renders as its picture, so a wrong one is
 * visible to every reader rather than buried in a score. These fix the three
 * ways it can be wrong: pointing somewhere unreachable, pointing at a scheme the
 * browser will not load, and carrying bytes the page chose rather than a link.
 */
describe("extract · the page's own image", () => {
	const withHead = (head: string) =>
		`<html><head>${head}</head><body><article><h1>T</h1><p>${"Body sentence with enough text to extract. ".repeat(8)}</p></article></body></html>`;

	const imageOf = (head: string, url = "https://shop.test/product/1") => {
		const result = extract(withHead(head), url);
		expect(result.ok).toBe(true);
		return result.ok ? result.extraction.image : null;
	};

	it("takes og:image", () => {
		expect(
			imageOf('<meta property="og:image" content="https://cdn.test/a.jpg">'),
		).toBe("https://cdn.test/a.jpg");
	});

	it("resolves a relative image against the page it came from", () => {
		expect(imageOf('<meta property="og:image" content="/img/a.jpg">')).toBe(
			"https://shop.test/img/a.jpg",
		);
	});

	it("upgrades http to https, which is the common real-world shape", () => {
		// Observed on live Shopify storefronts: the tag is written http, the CDN
		// serves both, and left alone the browser blocks it as mixed content.
		expect(
			imageOf('<meta property="og:image" content="http://cdn.test/a.jpg">'),
		).toBe("https://cdn.test/a.jpg");
	});

	it("refuses a data: URI rather than embedding a page's bytes", () => {
		expect(
			imageOf(
				'<meta property="og:image" content="data:image/svg+xml,<svg onload=alert(1)/>">',
			),
		).toBeNull();
	});

	// Not hypothetical: `new URL("::not a url::", base)` resolves rather than
	// throwing, so without the whitespace guard this returns a confident link to
	// `https://shop.test/product/::not%20a%20url::` and the fallback never runs.
	it("falls back to twitter:image, past an og:image that is not a URL", () => {
		expect(
			imageOf(
				'<meta property="og:image" content="::not a url::"><meta name="twitter:image" content="https://cdn.test/b.jpg">',
			),
		).toBe("https://cdn.test/b.jpg");
	});

	it("is null when the page declares nothing, rather than guessing", () => {
		expect(imageOf("<title>T</title>")).toBeNull();
	});
});

/**
 * The page's own date, for the freshness signal in `rank.ts`.
 *
 * Everything here is about not lying to the ranker. A date that is wrong is
 * worse than a date that is absent, because absence is handled — `applySignals`
 * never penalises a page for declaring nothing — while a wrong date actively
 * reorders results.
 */
describe("extract · publishedAt", () => {
	const page = (head: string) =>
		extract(
			`<!doctype html><html><head><title>T</title>${head}</head>
			 <body><article>${"A sentence with enough substance to extract. ".repeat(20)}</article></body></html>`,
			"https://example.com/a",
		);

	it("is null when the page declares nothing", () => {
		const result = page("");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Null, not "now" and not the epoch. Most of the web is this case.
		expect(result.extraction.publishedAt).toBeNull();
	});

	it("reads an article published time", () => {
		const result = page(
			'<meta property="article:published_time" content="2026-03-04T10:00:00Z">',
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.extraction.publishedAt).toBe("2026-03-04T10:00:00.000Z");
	});

	/**
	 * The question the ranker asks is "how current is this content", not "when
	 * did this URL first exist". A release-notes page written in 2009 and updated
	 * last week is current, and ranking it as sixteen years old is the exact
	 * failure the signal exists to prevent.
	 */
	it("prefers the modified time over the published time", () => {
		const result = page(
			'<meta property="article:published_time" content="2009-01-01T00:00:00Z">' +
				'<meta property="article:modified_time" content="2026-07-01T00:00:00Z">',
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.extraction.publishedAt).toBe("2026-07-01T00:00:00.000Z");
	});

	/**
	 * Placeholder dates are the trap. A great many pages emit `0001-01-01` or a
	 * Unix zero for "unset", and accepting one hands the ranker a document that
	 * is confidently ancient rather than one whose date is unknown.
	 */
	it("discards a placeholder date rather than believing it", () => {
		for (const value of ["0001-01-01T00:00:00Z", "1970-01-01T00:00:00Z"]) {
			const result = page(
				`<meta property="article:published_time" content="${value}">`,
			);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.extraction.publishedAt).toBeNull();
		}
	});

	it("discards a date far in the future", () => {
		const result = page(
			'<meta property="article:published_time" content="2099-01-01T00:00:00Z">',
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.extraction.publishedAt).toBeNull();
	});

	it("ignores an unparseable value instead of failing the extraction", () => {
		const result = page(
			'<meta property="article:published_time" content="last Tuesday-ish">',
		);
		// The page still extracts. A bad date is the page's problem and never a
		// reason to drop content we could read.
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.extraction.publishedAt).toBeNull();
	});

	it("falls back to a time element when no meta tag carries a date", () => {
		const result = extract(
			`<!doctype html><html><head><title>T</title></head>
			 <body><article><time datetime="2026-05-05">May</time>
			 ${"A sentence with enough substance to extract. ".repeat(20)}</article></body></html>`,
			"https://example.com/a",
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.extraction.publishedAt).toBe("2026-05-05T00:00:00.000Z");
	});
});
