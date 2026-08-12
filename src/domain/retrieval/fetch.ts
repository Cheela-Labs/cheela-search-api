import type { EgressClient } from "../../infra/egress/client";
import { EgressError } from "../../infra/egress/errors";
import { type Extraction, type ExtractionFailure, extract } from "./extract";

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

export type RetrievalOutcome =
	| { ok: true; page: RetrievedPage }
	| {
			ok: false;
			requestedUrl: string;
			/** An egress refusal, an HTTP status, or an extraction failure. */
			reason: ExtractionFailure | "http-error" | string;
			detail: string;
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
};

const DEFAULT_CONCURRENCY = 6;

async function retrieveOne(
	url: string,
	options: RetrieveOptions,
): Promise<RetrievalOutcome> {
	try {
		const response = await options.client.fetch(url);

		// A 404 or a 500 is a page that did not answer. Recorded as its own
		// reason rather than an extraction failure, because a corpus full of
		// `http-error` says something different about the upstream provider than
		// one full of `javascript-shell`.
		if (response.status >= 400) {
			return {
				ok: false,
				requestedUrl: url,
				reason: "http-error",
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
				reason: result.reason,
				detail: result.detail,
			};
		}

		return {
			ok: true,
			page: {
				requestedUrl: url,
				finalUrl: response.url,
				domain: new URL(response.url).hostname,
				status: response.status,
				extraction: result.extraction,
			},
		};
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
