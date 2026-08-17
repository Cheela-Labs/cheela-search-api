import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

/**
 * Stage 2 of the pipeline: turn fetched HTML into the text a reader would see.
 *
 * Readability over linkedom rather than a regex or a full browser. A regex
 * cannot tell an article from a navigation menu, and a browser costs a process
 * per page — this is the middle, and it is what Firefox's reader mode uses,
 * which is a good sign that it works on the actual web rather than on clean
 * HTML.
 *
 * The failure reasons below are all *ordinary*. A large share of the web
 * cannot be extracted — storefronts render their catalogue in JavaScript, news
 * sites gate their text — and treating that as an error rather than an outcome
 * makes the pipeline look broken when it is working correctly.
 */

export type ExtractionFailure =
	| "not-html"
	| "unparseable"
	| "javascript-shell"
	| "no-main-content"
	| "too-short";

export type Extraction = {
	title: string;
	text: string;
	canonicalUrl: string | null;
	image: string | null;
	publishedAt: number | null;
	language: string | null;
};

export type ExtractionResult =
	| { ok: true; extraction: Extraction }
	| { ok: false; reason: ExtractionFailure; preview: PagePreview };

/**
 * What is still worth having when the text is not.
 *
 * A page that extracts to nothing usually still publishes a complete `<head>`,
 * and for a shopping or navigation query that head — title, image, canonical
 * URL — is most of what a result card needs. Discarding it because the body
 * failed would drop exactly the pages those queries most want.
 */
export type PagePreview = {
	title: string;
	image: string | null;
	canonicalUrl: string | null;
};

const MIN_CHARS = 200;
/** Below this, a page with lots of script tags is a shell, not an article. */
const SHELL_TEXT_THRESHOLD = 200;

function meta(document: Document, selectors: string[]): string | null {
	for (const selector of selectors) {
		const element = document.querySelector(selector);
		const content =
			element?.getAttribute("content") ?? element?.getAttribute("href");
		if (content?.trim()) return content.trim();
	}
	return null;
}

function absolute(url: string | null, base: string): string | null {
	if (!url) return null;
	try {
		return new URL(url, base).toString();
	} catch {
		return null;
	}
}

function parseDate(value: string | null): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed)) return null;
	const seconds = Math.floor(parsed / 1000);
	// A date in the future, or before the web existed, is a parsing accident
	// rather than a publication date.
	const now = Math.floor(Date.now() / 1000);
	if (seconds > now + 86_400 || seconds < 631_152_000) return null;
	return seconds;
}

export function extract(
	html: string,
	url: string,
	contentType = "text/html",
): ExtractionResult {
	if (!/html|xml/i.test(contentType)) {
		return {
			ok: false,
			reason: "not-html",
			preview: { title: "", image: null, canonicalUrl: null },
		};
	}

	let document: Document;
	try {
		({ document } = parseHTML(html) as unknown as { document: Document });
	} catch {
		return {
			ok: false,
			reason: "unparseable",
			preview: { title: "", image: null, canonicalUrl: null },
		};
	}

	const preview: PagePreview = {
		title:
			meta(document, [
				'meta[property="og:title"]',
				'meta[name="twitter:title"]',
			]) ??
			document.querySelector("title")?.textContent?.trim() ??
			"",
		image: absolute(
			meta(document, [
				'meta[property="og:image"]',
				'meta[name="twitter:image"]',
			]),
			url,
		),
		canonicalUrl: absolute(meta(document, ['link[rel="canonical"]']), url),
	};

	const bodyText = document.body?.textContent?.trim() ?? "";
	const scripts = document.querySelectorAll("script").length;
	if (bodyText.length < SHELL_TEXT_THRESHOLD && scripts > 3) {
		// A single-page application that has not run. There is no text here to
		// find and retrying will not produce any.
		return { ok: false, reason: "javascript-shell", preview };
	}

	let article: { title?: string | null; textContent?: string | null } | null;
	try {
		article = new Readability(document as never).parse();
	} catch {
		return { ok: false, reason: "unparseable", preview };
	}

	const text = article?.textContent?.replace(/\n{3,}/g, "\n\n").trim() ?? "";
	if (!article || !text) {
		return { ok: false, reason: "no-main-content", preview };
	}
	if (text.length < MIN_CHARS) {
		return { ok: false, reason: "too-short", preview };
	}

	return {
		ok: true,
		extraction: {
			title: (article.title || preview.title || "").trim(),
			text,
			canonicalUrl: preview.canonicalUrl,
			image: preview.image,
			publishedAt: parseDate(
				meta(document, [
					'meta[property="article:published_time"]',
					'meta[name="publish-date"]',
					'meta[name="date"]',
					"time[datetime]",
				]) ??
					document.querySelector("time")?.getAttribute("datetime") ??
					null,
			),
			language:
				document.documentElement?.getAttribute("lang")?.slice(0, 8) ?? null,
		},
	};
}
