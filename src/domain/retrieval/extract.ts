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
	text: string;
	/** Of the extracted text, so a page whose only change was an ad slot hashes the same. */
	contentHash: string;
};

export type ExtractionResult =
	| { ok: true; extraction: Extraction }
	| { ok: false; reason: ExtractionFailure; detail: string };

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
			};
		}
	}

	const canonicalUrl = canonicalFrom(document, url);

	// Readability mutates the document it is given, and we read the canonical
	// above first for exactly that reason.
	const article = new Readability(document as never).parse();
	if (!article?.content) {
		return { ok: false, reason: "no-main-content", detail: "no article found" };
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
		};
	}

	return {
		ok: true,
		extraction: {
			title: article.title?.trim() || null,
			canonicalUrl,
			text,
			contentHash: createHash("sha256").update(text).digest("hex"),
		},
	};
}
