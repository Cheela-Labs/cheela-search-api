import type {
	CachedDocument,
	DocumentStore,
} from "../../infra/db/document-store";
import type { EgressClient } from "../../infra/egress/client";
import { EgressError } from "../../infra/egress/errors";
import { recordHit, recordMiss, recordRevalidated } from "../../shared/metrics";
import {
	type Extraction,
	type ExtractionFailure,
	extract,
	type PagePreview,
} from "./extract";

/**
 * Fetch and extract, in parallel, dropping what does not arrive.
 *
 * The rule from PLAN.md's step 4 is that a slow page is dropped, never waited
 * on. That is not a timeout on this function — it is a property of every page
 * being independent: one URL that hangs costs its own slot and nothing else,
 * because the deadline lives in the egress client and applies per request.
 *
 * Nothing here throws. A retrieval stage that can fail as a unit turns one bad
 * URL into a failed query, and the whole point of asking ten sources is that
 * some of them will not answer. Every URL produces an outcome, and the caller
 * decides whether enough of them worked.
 */

export type RetrievedPage = {
	requestedUrl: string;
	/** After redirects. Not necessarily the canonical — see `extraction`. */
	finalUrl: string;
	/**
	 * Host, not registrable domain, and this is the join key to the capability
	 * plane. ADS manifests live at a specific host's `/.well-known/`, so
	 * `docs.example.com` and `example.com` can publish different capabilities —
	 * collapsing them to an eTLD+1 would merge two sites that made two different
	 * declarations.
	 */
	domain: string;
	status: number;
	extraction: Extraction;
};

/**
 * Why an HTTP response was not a page we could read.
 *
 * These were one bucket called `http-error`, which made 40% of the eval
 * harness's failures unreadable: it could not tell a site declining to be read
 * from a URL the upstream provider invented. They are different problems with
 * different owners, and only some are ours.
 *
 * - `refused-by-site` — 401, 403, 451. A site declining to serve an identified
 *   bot. **Not a bug and deliberately not fixed**: PLAN.md refuses to spoof a
 *   browser user agent to get around it, so this is a category we accept rather
 *   than a number we drive down.
 * - `not-found` — 404, 410. The URL does not exist. That is a *provider*
 *   quality signal: the index handed us something stale.
 * - `rate-limited` — 429. Ours, and the only one that says slow down.
 * - `server-error` — 5xx. Theirs, transient, and worth retrying another day
 *   rather than treating as a permanent property of the page.
 */
export type HttpFailure =
	| "refused-by-site"
	| "not-found"
	| "rate-limited"
	| "server-error"
	| "http-error";

export function httpFailure(status: number): HttpFailure {
	if (status === 401 || status === 403 || status === 451)
		return "refused-by-site";
	if (status === 404 || status === 410) return "not-found";
	if (status === 429) return "rate-limited";
	if (status >= 500) return "server-error";
	return "http-error";
}

export type RetrievalOutcome =
	| { ok: true; page: RetrievedPage }
	| {
			ok: false;
			requestedUrl: string;
			/** After redirects, when a response arrived at all. */
			finalUrl?: string;
			domain?: string;
			/** An egress refusal, an HTTP status, or an extraction failure. */
			reason: ExtractionFailure | HttpFailure | string;
			detail: string;
			/**
			 * What the page said about itself, when it parsed but could not be read.
			 *
			 * A failed extraction is still a failed extraction — this page will never
			 * be cited and nothing will claim it said anything. But a storefront that
			 * renders its catalogue in JavaScript is the single most common failure
			 * on a discovery query, and its `<head>` is intact. Keeping it is the
			 * difference between "we found twelve shops" and showing none of them.
			 */
			preview?: PagePreview;
	  };

export type RetrievalStats = {
	requested: number;
	extracted: number;
	/** `extracted / requested`, the number PLAN.md gates step 4 on. */
	successRate: number;
	failures: Record<string, number>;
};

export type RetrieveOptions = {
	client: EgressClient;
	/**
	 * How many fetches are in flight at once. Not the number of URLs — the
	 * upstream gives 6–10 candidates and all of them start, but a burst of
	 * sockets against one host is how a crawler earns a block.
	 */
	concurrency?: number;
	minChars?: number;
	/**
	 * The content cache. Absent means every page is fetched, which is exactly
	 * how this behaved before step 7 — the cache is an optimisation, never a
	 * dependency, and a database that is down must not stop a search.
	 */
	cache?: DocumentStore;
};

const DEFAULT_CONCURRENCY = 6;

/** A cached page, shaped as though it had just been fetched. */
function fromCache(cached: CachedDocument): RetrievalOutcome {
	return {
		ok: true,
		page: {
			requestedUrl: cached.url,
			finalUrl: cached.canonicalUrl,
			domain: cached.domain,
			status: cached.status,
			extraction: cached.extraction,
		},
	};
}

async function retrieveOne(
	url: string,
	options: RetrieveOptions,
): Promise<RetrievalOutcome> {
	/*
	  Three outcomes, in cost order:

	  - fresh in cache      → no request at all
	  - stale with an etag  → one conditional request, and a 304 costs no body,
	                          no extraction and no re-chunking
	  - anything else       → the full fetch this function has always done

	  The cached copy is held across the request so a 304 has something to
	  return: the whole point of `If-None-Match` is that the response carries no
	  body, so the body has to come from here.
	*/
	const cached = options.cache ? await options.cache.get(url) : null;

	if (cached?.fresh) {
		recordHit("content");
		return fromCache(cached);
	}

	const conditional = cached?.etag
		? { "if-none-match": cached.etag }
		: undefined;

	try {
		const response = await options.client.fetch(
			url,
			conditional ? { headers: conditional } : undefined,
		);

		// Unchanged since we last read it. Push the expiry out and serve what we
		// already hold — this is the case the TTL exists to make cheap, not the
		// case it exists to prevent.
		if (response.status === 304 && cached) {
			recordRevalidated("content");
			await options.cache?.touch(cached.canonicalUrl);
			return fromCache(cached);
		}

		recordMiss("content");

		// A page that did not answer, named by *why* rather than by status.
		// A corpus full of these says something different about the upstream
		// provider than one full of `javascript-shell` — and the four kinds
		// below say different things again. See `httpFailure`.
		if (response.status >= 400) {
			return {
				ok: false,
				requestedUrl: url,
				finalUrl: response.url,
				domain: new URL(response.url).hostname,
				reason: httpFailure(response.status),
				detail: `status ${response.status}`,
			};
		}

		const result = extract(response.body.toString("utf8"), response.url, {
			contentType: response.headers["content-type"] ?? null,
			minChars: options.minChars,
		});

		if (!result.ok) {
			return {
				ok: false,
				requestedUrl: url,
				finalUrl: response.url,
				domain: new URL(response.url).hostname,
				reason: result.reason,
				detail: result.detail,
				preview: result.preview,
			};
		}

		const page = {
			requestedUrl: url,
			finalUrl: response.url,
			domain: new URL(response.url).hostname,
			status: response.status,
			extraction: result.extraction,
		};

		// Awaited rather than fired and forgotten. On Cloud Run a promise left
		// running past the response is a promise the instance may be frozen in
		// the middle of, so "fire and forget" quietly becomes "sometimes write".
		// One insert against a warm pool is cheaper than that ambiguity.
		await options.cache?.put({
			requestedUrl: url,
			finalUrl: response.url,
			domain: page.domain,
			status: response.status,
			extraction: result.extraction,
			etag: response.headers.etag ?? null,
		});

		return { ok: true, page };
	} catch (error) {
		return {
			ok: false,
			requestedUrl: url,
			reason: error instanceof EgressError ? error.reason : "request-failed",
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function retrievePages(
	urls: readonly string[],
	options: RetrieveOptions,
): Promise<{ outcomes: RetrievalOutcome[]; stats: RetrievalStats }> {
	// Deduplicated before anything is fetched: an upstream returning the same
	// URL twice should cost one request, not two, and should not let one page
	// contribute two passages to the same answer.
	const unique = [...new Set(urls)];
	const limit = options.concurrency ?? DEFAULT_CONCURRENCY;

	const outcomes: RetrievalOutcome[] = new Array(unique.length);
	let next = 0;

	// A fixed pool of workers pulling from one cursor, rather than chunking into
	// batches. Batching makes every batch as slow as its slowest URL, which is
	// the behaviour the "drop, never wait" rule exists to avoid.
	const worker = async (): Promise<void> => {
		while (true) {
			const index = next;
			next += 1;
			const url = unique[index];
			if (url === undefined) return;
			outcomes[index] = await retrieveOne(url, options);
		}
	};

	await Promise.all(
		Array.from({ length: Math.min(limit, unique.length) }, worker),
	);

	const failures: Record<string, number> = {};
	let extracted = 0;
	for (const outcome of outcomes) {
		if (outcome.ok) extracted += 1;
		else failures[outcome.reason] = (failures[outcome.reason] ?? 0) + 1;
	}

	return {
		outcomes,
		stats: {
			requested: unique.length,
			extracted,
			successRate: unique.length === 0 ? 0 : extracted / unique.length,
			failures,
		},
	};
}
