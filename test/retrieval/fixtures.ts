import type { ExtractionFailure } from "../../src/domain/retrieval/extract";

/**
 * Page shapes the extractor has to survive.
 *
 * These model real pages rather than being real pages. Shipping a corpus of
 * third-party HTML would mean redistributing other people's content and
 * carrying megabytes of it in the repository, so what is here is the *structure*
 * of the cases that break extractors: chrome that outweighs the article, content
 * in unmarked divs, an old-school table layout, a client-rendered shell.
 *
 * That substitution is a real weakness and it is named in PLAN.md: a success
 * rate measured against fixtures somebody designed to pass is weaker evidence
 * than one measured against pages nobody chose. The mitigation is that each case
 * asserts *content*, not just absence of failure — the extraction must contain
 * the article's marker sentence and must not contain the boilerplate's. An
 * extractor that returns the nav bar scores zero on that even though it
 * "succeeded".
 *
 * When the crawler has a real corpus, these become the regression set and the
 * rate gets measured against the real thing.
 */

const PARAGRAPH =
	"Provisioned concurrency keeps a warm instance floor, which is exactly what a bursty workload pays for and never uses. ";

const body = (times: number) => PARAGRAPH.repeat(times);

const CHROME = `
<nav id="site-nav"><a href="/">Home</a><a href="/pricing">Pricing</a><a href="/docs">Docs</a></nav>
<div class="cookie-banner">We value your privacy. Accept all cookies?</div>
<aside class="sidebar"><h3>Related reading</h3><ul><li><a href="/a">Another post entirely</a></li><li><a href="/b">Yet another post</a></li></ul></aside>
`;

const FOOTER = `
<footer><p>Copyright 2026 Example Corp. All rights reserved. Terms. Privacy.</p></footer>
`;

export type Fixture = {
	name: string;
	url: string;
	html: string;
	/** `"ok"`, or the reason this shape must be refused with. */
	expect: "ok" | ExtractionFailure;
	/** Must appear in the extracted text. Proves the article survived. */
	mustContain?: string[];
	/** Must not. Proves the chrome did not. */
	mustNotContain?: string[];
};

export const fixtures: Fixture[] = [
	{
		name: "article with heavy chrome",
		url: "https://example.test/posts/bursty",
		html: `<html><head><title>Deploying bursty APIs</title></head><body>
			${CHROME}
			<article><h1>Deploying bursty APIs</h1><p>${body(6)}</p><p>SENTINEL_ARTICLE_BODY. ${body(4)}</p></article>
			${FOOTER}</body></html>`,
		expect: "ok",
		mustContain: ["SENTINEL_ARTICLE_BODY"],
		mustNotContain: ["We value your privacy", "All rights reserved"],
	},
	{
		name: "documentation page with code",
		url: "https://docs.example.test/runtime/limits",
		html: `<html><head><title>Runtime limits</title></head><body>
			<nav class="docs-nav"><a href="/a">Getting started</a><a href="/b">API</a></nav>
			<main><h1>Runtime limits</h1><p>${body(5)}</p>
			<pre><code>export default {
  async fetch(request) {
    return new Response("SENTINEL_CODE_LINE");
  }
}</code></pre>
			<p>${body(4)}</p></main>
			${FOOTER}</body></html>`,
		expect: "ok",
		// Code has to survive with its newlines: a citation into mangled code is
		// worse than no citation.
		mustContain: ["SENTINEL_CODE_LINE", "async fetch(request) {"],
		mustNotContain: ["Getting started"],
	},
	{
		name: "content in unmarked divs",
		url: "https://old.example.test/notes",
		// No <article>, no <main>, no useful class names. Readability's weakest
		// case and a very common one.
		html: `<html><head><title>Notes</title></head><body>
			${CHROME}
			<div><div><h2>Some notes</h2><div>${body(8)}</div><div>SENTINEL_UNMARKED. ${body(5)}</div></div></div>
			${FOOTER}</body></html>`,
		expect: "ok",
		mustContain: ["SENTINEL_UNMARKED"],
		mustNotContain: ["Related reading"],
	},
	{
		name: "old-school table layout",
		url: "https://legacy.example.test/page",
		html: `<html><head><title>Legacy</title></head><body>
			<table><tr><td class="nav">Home | About | Contact</td></tr>
			<tr><td><h1>A page from 2004</h1><p>${body(7)}</p><p>SENTINEL_TABLE_BODY. ${body(4)}</p></td></tr>
			<tr><td>Copyright 2004 Webmaster</td></tr></table>
			</body></html>`,
		expect: "ok",
		mustContain: ["SENTINEL_TABLE_BODY"],
	},
	{
		name: "forum thread",
		url: "https://forum.example.test/t/1234",
		html: `<html><head><title>Migrating an Express API</title></head><body>
			${CHROME}
			<div class="thread">
				<div class="post"><h1>Migrating an Express API</h1><p>${body(4)}</p><p>SENTINEL_QUESTION. ${body(3)}</p></div>
				<div class="post"><p>${body(5)}</p></div>
			</div>
			${FOOTER}</body></html>`,
		expect: "ok",
		mustContain: ["SENTINEL_QUESTION"],
	},
	{
		name: "news article with interleaved ad slots",
		url: "https://news.example.test/story",
		html: `<html><head><title>Story</title></head><body>
			${CHROME}
			<article><h1>Story</h1><p>${body(4)}</p>
			<div class="ad-slot">ADVERTISEMENT — buy this thing now</div>
			<p>SENTINEL_NEWS_BODY. ${body(4)}</p>
			<div class="ad-slot">ADVERTISEMENT — and this one</div>
			<p>${body(4)}</p></article>
			${FOOTER}</body></html>`,
		expect: "ok",
		mustContain: ["SENTINEL_NEWS_BODY"],
	},
	{
		name: "article carrying a canonical elsewhere",
		url: "https://example.test/posts/dupe?utm_source=x",
		html: `<html><head><title>Dupe</title>
			<link rel="canonical" href="https://example.test/posts/original">
			</head><body>
			<article><h1>Dupe</h1><p>${body(6)}</p><p>SENTINEL_CANONICAL. ${body(4)}</p></article>
			</body></html>`,
		expect: "ok",
		mustContain: ["SENTINEL_CANONICAL"],
	},
	{
		name: "spec table page",
		url: "https://example.test/specs",
		html: `<html><head><title>Specs</title></head><body>
			<main><h1>Comparison</h1><p>${body(5)}</p>
			<table><tr><th>Platform</th><th>Cold start</th></tr>
			<tr><td>SENTINEL_TABLE_CELL</td><td>0 ms</td></tr>
			<tr><td>Fargate</td><td>3.4 s</td></tr></table>
			<p>${body(4)}</p></main>
			</body></html>`,
		expect: "ok",
		mustContain: ["SENTINEL_TABLE_CELL"],
	},

	/* ---- shapes that must be refused, each with its own reason ---- */

	{
		name: "client-rendered shell",
		url: "https://app.example.test/",
		// The failure that matters most: a 200, valid HTML, and no content. An
		// extractor that reports this as an empty success sends the composer to
		// write an answer from nothing.
		html: `<html><head><title>App</title></head><body>
			<div id="root"></div>
			<script src="/assets/index-4f2a.js"></script>
			<script>window.__STATE__={};</script>
			</body></html>`,
		expect: "javascript-shell",
	},
	{
		name: "stub page",
		url: "https://example.test/stub",
		html: `<html><head><title>Stub</title></head><body><main><h1>Stub</h1><p>Nothing here yet.</p></main></body></html>`,
		expect: "too-short",
	},
	{
		name: "navigation with no article",
		url: "https://example.test/index",
		html: `<html><head><title>Index</title></head><body>${CHROME}${FOOTER}</body></html>`,
		expect: "too-short",
	},
	{
		name: "not markup at all",
		url: "https://example.test/data.json",
		html: `{"status":"ok","items":[1,2,3]}`,
		expect: "not-html",
	},
];

export const shouldExtract = fixtures.filter((f) => f.expect === "ok");
export const shouldRefuse = fixtures.filter((f) => f.expect !== "ok");
