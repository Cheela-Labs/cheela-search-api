import { createHash } from "node:crypto";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

/**
 * Main-content extraction.
 *
 * ## Why this returns a reason instead of an empty string
 *
 * The single most expensive thing this module can do is fail quietly. A page
 * whose content never arrived — a JavaScript shell, a consent wall, a 200 that
 * is really an error — extracts to "" or to a nav bar, and downstream that is
 * indistinguishable from a page that genuinely said nothing. The composer then
 * writes a poor answer from thin passages and the whole stage looks like a
 * model problem, which is where the next week goes.
 *
 * So every outcome is either a usable extraction or a named reason, and the
 * caller counts them. `extraction success rate` in PLAN.md is that count, and
 * it is a gate on step 4 precisely because it is cheap to measure here and
 * impossible to attribute later.
 *
 * ## linkedom rather than jsdom
 *
 * Readability wants a DOM. jsdom is the reference implementation and is roughly
 * an order of magnitude slower to parse; this runs on the request path for six
 * to ten pages at once, inside a stage the latency budget gives ~1.2s. linkedom
 * parses and extracts a typical article in single-digit milliseconds and
 * Readability is happy with it — verified, not assumed: the suite asserts that
 * nav is dropped and `<pre>` survives, which is what a DOM shim usually breaks.
 */

export type ExtractionFailure =
	/** Not markup at all, or a content type we do not read. */
	| "not-html"
	/** The parser could not produce a document. */
	| "unparseable"
	/** Body is a mount point and the content never rendered. */
	| "javascript-shell"
	/** Parsed, but Readability found no article. */
	| "no-main-content"
	/** Found something, and it is too little to cite. */
	| "too-short";

export type Extraction = {
	title: string | null;
	/** `<link rel="canonical">` resolved against the fetched URL, else that URL. */
	canonicalUrl: string;
	/**
	 * The page's own `og:image`, absolute and https, or null.
	 *
	 * Taken from the page it will be displayed with, which is the whole point:
	 * the alternative — pairing a result with an image from somewhere else that
	 * matched the query — invents a relationship that does not exist. Here the
	 * pairing is true by construction, and a page that declares no image simply
	 * has none.
	 */
	image: string | null;
	text: string;
	/**
	 * When the page says it was published or last changed, as an ISO string, or
	 * null when it does not say.
	 *
	 * **Null is the common case and is never treated as "old".** Most of the web
	 * declares no date, so a ranker that penalised absence would be ranking on
	 * whether a CMS emits Open Graph tags. Freshness can only ever *promote* a
	 * page that proved it is recent — see `applySignals` in `rank.ts`.
	 *
	 * Read from meta tags and `<time datetime>` only. JSON-LD `datePublished` is
	 * common on news sites and is deliberately not parsed yet: it means walking
	 * every `<script type="application/ld+json">` block on an untrusted page, and
	 * the meta tags cover enough to measure whether this signal is worth more.
	 */
	publishedAt: string | null;
	/** Of the extracted text, so a page whose only change was an ad slot hashes the same. */
	contentHash: string;
};

/**
 * What a page says about itself in its `<head>`, whether or not it has a body
 * we could read.
 *
 * This exists because of a measured asymmetry: the pages that fail extraction
 * hardest are storefronts, which are JavaScript shells — and a shell still ships
 * a complete `<head>`. Eight of twelve pages retrieved for "nike jordans"
 * extracted nothing, and nearly all of them carried a perfectly good title and
 * `og:image` the whole time.
 *
 * A page we could not read is not a source: there is no passage to cite and we
 * will not claim it said anything. It can still be a *destination*, and throwing
 * the head away meant discovery queries retrieved twelve shops and could show
 * none of them.
 */
export type PagePreview = { title: string | null; image: string | null };

export type ExtractionResult =
	| { ok: true; extraction: Extraction }
	| {
			ok: false;
			reason: ExtractionFailure;
			detail: string;
			/** Present whenever the document parsed, even though the body did not survive. */
			preview?: PagePreview;
	  };

export type ExtractOptions = {
	/** From the response, when there is one. */
	contentType?: string | null;
	/** Below this many characters, an extraction is not worth citing. */
	minChars?: number;
};

const DEFAULT_MIN_CHARS = 200;

/** Below this much raw body text, a page with scripts is a shell, not a page. */
const SHELL_TEXT_THRESHOLD = 200;

const HTML_TYPES = ["text/html", "application/xhtml+xml", "text/plain"];

/** Elements whose end implies a line break in the serialised text. */
const BLOCK = new Set([
	"ADDRESS",
	"ARTICLE",
	"ASIDE",
	"BLOCKQUOTE",
	"DD",
	"DIV",
	"DL",
	"DT",
	"FIELDSET",
	"FIGCAPTION",
	"FIGURE",
	"FOOTER",
	"FORM",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"HEADER",
	"HR",
	"LI",
	"MAIN",
	"NAV",
	"OL",
	"P",
	"PRE",
	"SECTION",
	"TABLE",
	"TD",
	"TH",
	"TR",
	"UL",
]);

/**
 * Serialises Readability's output to text.
 *
 * Not `article.textContent`: that runs every block together, so a heading fuses
 * with the sentence after it and a code sample becomes one line. Both matter —
 * chunking downstream splits on blank lines, and a citation into mangled code is
 * worse than no citation.
 */
function serialise(node: Node): string {
	const out: string[] = [];

	const walk = (current: Node, insidePre: boolean): void => {
		// Node.TEXT_NODE — the numeric constant, since linkedom's Node is not the
		// global one and `instanceof Text` is unreliable across realms.
		if (current.nodeType === 3) {
			const value = current.textContent ?? "";
			out.push(insidePre ? value : value.replace(/\s+/g, " "));
			return;
		}
		if (current.nodeType !== 1) return;

		const element = current as Element;
		const tag = element.tagName?.toUpperCase() ?? "";

		if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return;

		if (tag === "BR") {
			out.push("\n");
			return;
		}

		const pre = insidePre || tag === "PRE";
		for (const child of Array.from(element.childNodes)) walk(child, pre);
		if (BLOCK.has(tag)) out.push("\n");
	};

	walk(node, false);

	return (
		out
			.join("")
			// Collapse runs of blank lines to one, and trim each line's edges. Three
			// blank lines carry no more meaning than one and cost tokens downstream.
			.replace(/[ \t]+\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			.trim()
	);
}

function canonicalFrom(document: Document, url: string): string {
	const href = document
		.querySelector('link[rel="canonical"]')
		?.getAttribute("href");
	if (!href) return url;
	try {
		return new URL(href, url).toString();
	} catch {
		// A malformed canonical is the page's problem, not a reason to drop it.
		return url;
	}
}

/**
 * The page's declared preview image, in the order publishers actually set it.
 *
 * Two rules that are not cosmetic:
 *
 * - **http is upgraded to https.** The surface is served over https, so a
 *   plain-http image is blocked as mixed content and renders as a hole. Every
 *   host seen doing this in practice wrote the tag against a CDN that serves
 *   both; upgrading turns a guaranteed failure into a very likely success.
 * - **Only http(s) survives.** `data:` URIs would embed arbitrary attacker
 *   bytes from an untrusted page directly into our response.
 */
function imageFrom(document: Document, url: string): string | null {
	const selectors = [
		'meta[property="og:image:secure_url"]',
		'meta[property="og:image"]',
		'meta[name="og:image"]',
		'meta[name="twitter:image"]',
		'meta[name="twitter:image:src"]',
	];

	for (const selector of selectors) {
		const content = document
			.querySelector(selector)
			?.getAttribute("content")
			?.trim();
		if (!content) continue;

		// Whitespace is never legal in a URL reference, and without this check it
		// is not caught: `new URL("::not a url::", base)` does not throw, it
		// resolves as a *relative* path and yields a confident link to nothing.
		// Every malformed value would become a broken image rather than no image.
		if (/\s/.test(content)) continue;

		try {
			const resolved = new URL(content, url);
			if (resolved.protocol === "http:") resolved.protocol = "https:";
			if (resolved.protocol !== "https:") continue;
			return resolved.toString();
		} catch {
			// A malformed image URL is the page's problem. Try the next tag.
		}
	}

	return null;
}

/**
 * The earliest year a page date is believed rather than discarded.
 *
 * Not paranoia about the 1990s web: a great many pages emit `0001-01-01` or a
 * Unix epoch zero for "unset", and a date parser that accepts those hands the
 * ranker a document that is confidently 55 years old rather than one whose date
 * is unknown. Those are different things and only one of them is true.
 */
const EARLIEST_PLAUSIBLE = Date.UTC(1990, 0, 1);

/** Clocks disagree; a page dated slightly ahead of ours is not lying. */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1_000;

/**
 * When the page says it was published or last changed.
 *
 * Modified time is preferred over published time, because what the ranker is
 * asked is "how current is this content", not "when did this URL first exist".
 * A release-notes page written in 2009 and updated last week is current, and
 * ranking it as sixteen years old is exactly the failure the freshness signal
 * is for.
 */
function publishedFrom(document: Document): string | null {
	const selectors = [
		'meta[property="article:modified_time"]',
		'meta[property="og:updated_time"]',
		'meta[property="article:published_time"]',
		'meta[itemprop="datePublished"]',
		'meta[name="date"]',
		'meta[name="pubdate"]',
		'meta[name="last-modified"]',
	];

	const candidates: (string | null | undefined)[] = selectors.map((selector) =>
		document.querySelector(selector)?.getAttribute("content"),
	);

	// `<time datetime>` last: it is markup a page may use many times, and the
	// first one is as likely to be a comment's timestamp as the article's.
	candidates.push(
		document.querySelector("time[datetime]")?.getAttribute("datetime"),
	);

	for (const candidate of candidates) {
		const raw = candidate?.trim();
		if (!raw) continue;

		const parsed = Date.parse(raw);
		if (Number.isNaN(parsed)) continue;
		if (parsed < EARLIEST_PLAUSIBLE) continue;
		if (parsed > Date.now() + FUTURE_TOLERANCE_MS) continue;

		return new Date(parsed).toISOString();
	}

	return null;
}

/** The page's own name for itself, preferring what it chose to be shared as. */
function titleFrom(document: Document): string | null {
	const candidates = [
		document
			.querySelector('meta[property="og:title"]')
			?.getAttribute("content"),
		document
			.querySelector('meta[name="twitter:title"]')
			?.getAttribute("content"),
		document.querySelector("title")?.textContent,
	];

	for (const candidate of candidates) {
		const trimmed = candidate?.replace(/\s+/g, " ").trim();
		if (trimmed) return trimmed;
	}

	return null;
}

export function extract(
	html: string,
	url: string,
	options: ExtractOptions = {},
): ExtractionResult {
	const minChars = options.minChars ?? DEFAULT_MIN_CHARS;

	if (options.contentType) {
		const type = options.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
		if (!HTML_TYPES.includes(type)) {
			return { ok: false, reason: "not-html", detail: type };
		}
	}

	if (!html.trim()) {
		return { ok: false, reason: "not-html", detail: "empty response" };
	}

	let document: Document;
	try {
		({ document } = parseHTML(html) as unknown as { document: Document });
	} catch (error) {
		return {
			ok: false,
			reason: "unparseable",
			detail: error instanceof Error ? error.message : String(error),
		};
	}

	// `documentElement` first, and it is not paranoia: linkedom's `get body`
	// destructures `documentElement`, so on input that is not markup at all — a
	// JSON response served without a content type — reading `.body` throws
	// rather than returning null. Checking the root is the only safe probe.
	if (!document?.documentElement) {
		return { ok: false, reason: "not-html", detail: "no document element" };
	}
	if (!document.body) {
		return { ok: false, reason: "unparseable", detail: "no body element" };
	}

	// Read now, before Readability is allowed to mutate the document — and before
	// any of the failure returns below, all of which carry it.
	const preview: PagePreview = {
		title: titleFrom(document),
		image: imageFrom(document, url),
	};

	const rawText = (document.body.textContent ?? "").trim();

	// A shell is a page whose content is somewhere we cannot reach. Distinguished
	// from a genuinely short page by the presence of scripts: an almost-empty
	// body plus a bundle is a client-rendered app, and reporting that as a
	// successful extraction of nothing is the failure this whole taxonomy exists
	// to prevent.
	if (rawText.length < SHELL_TEXT_THRESHOLD) {
		const scripts = document.querySelectorAll("script").length;
		if (scripts > 0) {
			return {
				ok: false,
				reason: "javascript-shell",
				detail: `${rawText.length} chars of text behind ${scripts} script tag(s)`,
				preview,
			};
		}
	}

	const canonicalUrl = canonicalFrom(document, url);
	// Read before Readability, with the canonical and the image, and for the same
	// reason: it strips the document down to the article and the date lives in
	// the head.
	const publishedAt = publishedFrom(document);

	// Readability mutates the document it is given, and we read the canonical
	// and the image above first for exactly that reason.
	const article = new Readability(document as never).parse();
	if (!article?.content) {
		return {
			ok: false,
			reason: "no-main-content",
			detail: "no article found",
			preview,
		};
	}

	// A complete document, not a bare `<body>` wrapper. linkedom parses the
	// fragment form into a document whose body is empty — silently, so the
	// symptom is a perfect extraction of zero characters.
	const { document: contentDocument } = parseHTML(
		`<html><body>${article.content}</body></html>`,
	) as unknown as { document: Document };
	const text = serialise(contentDocument.body as unknown as Node);

	if (text.length < minChars) {
		return {
			ok: false,
			reason: "too-short",
			detail: `${text.length} chars, need ${minChars}`,
			preview,
		};
	}

	return {
		ok: true,
		extraction: {
			title: article.title?.trim() || preview.title,
			canonicalUrl,
			image: preview.image,
			text,
			publishedAt,
			contentHash: createHash("sha256").update(text).digest("hex"),
		},
	};
}
