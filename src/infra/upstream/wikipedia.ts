import type { EgressClient } from "../egress/client";
import {
	type Candidate,
	DEFAULT_LIMIT,
	normaliseCandidates,
	type SearchOptions,
	type SearchProvider,
	UpstreamError,
} from "./types";

/**
 * Wikipedia, through the MediaWiki search API.
 *
 * ## Why a specialist rather than a third general vendor
 *
 * It costs nothing. No key, no quota to share with production traffic, no
 * account that can be terminated — which makes it the one retriever that can be
 * added to *every* query without touching the unit economics PLAN.md says the
 * content cache exists to protect. A third general vendor would be another bill
 * measuring the same web.
 *
 * It is also reliably readable, which is rarer than it sounds. 41% of retrieval
 * failures in the eval set are `refused-by-site` — sites declining to serve an
 * identified bot — and this is a corpus that has never once refused us. On an
 * informational query it contributes a page that will actually extract, which
 * is worth more than a page that ranks better and returns 403.
 *
 * ## What it is not
 *
 * Not a source of truth, and not weighted as one. It joins the candidate pool
 * on equal terms and its passages are ranked against everything else by the
 * same BM25; a Wikipedia URL that says nothing relevant loses to a blog post
 * that does. Trusting a domain is a ranking signal this pipeline deliberately
 * does not have yet.
 *
 * ## Search, not summary
 *
 * `list=search` returns titles; the page itself is then fetched and read by the
 * ordinary retrieval path. The API will happily return an extract, and taking
 * it would be citing a summary we did not verify — the same reason `Candidate`
 * has no snippet field.
 */

const ENDPOINT = "https://en.wikipedia.org/w/api.php";
const ARTICLE_BASE = "https://en.wikipedia.org/wiki/";

type SearchHit = { title?: unknown };

export function createWikipediaProvider(
	client: EgressClient,
	endpoint: string = ENDPOINT,
	articleBase: string = ARTICLE_BASE,
): SearchProvider {
	return {
		name: "wikipedia",

		async search(
			query: string,
			options: SearchOptions = {},
		): Promise<Candidate[]> {
			const limit = options.limit ?? DEFAULT_LIMIT;

			const url = new URL(endpoint);
			url.searchParams.set("action", "query");
			url.searchParams.set("list", "search");
			url.searchParams.set("srsearch", query);
			url.searchParams.set("srlimit", String(limit));
			// Namespace 0 is articles. Without this, a query matching a talk page or
			// a user sandbox returns one, and those are not encyclopedia content.
			url.searchParams.set("srnamespace", "0");
			url.searchParams.set("format", "json");
			url.searchParams.set("formatversion", "2");

			let response: Awaited<ReturnType<EgressClient["fetch"]>>;
			try {
				response = await client.fetch(url.toString(), {
					headers: { accept: "application/json" },
					...(options.signal ? { signal: options.signal } : {}),
				});
			} catch (error) {
				throw new UpstreamError(
					"wikipedia",
					error instanceof Error ? error.message : String(error),
				);
			}

			if (response.status !== 200) {
				throw new UpstreamError(
					"wikipedia",
					`HTTP ${response.status}`,
					response.status,
				);
			}

			let payload: { query?: { search?: unknown } };
			try {
				payload = JSON.parse(response.body.toString("utf8")) as {
					query?: { search?: unknown };
				};
			} catch {
				throw new UpstreamError("wikipedia", "response was not JSON");
			}

			// A missing `query.search` is a changed contract, not an empty result
			// set — the same distinction Tavily's provider draws, and for the same
			// reason: conflating them turns an API change into "no answer".
			const hits = payload.query?.search;
			if (!Array.isArray(hits)) {
				throw new UpstreamError(
					"wikipedia",
					"response had no `query.search` array — the API shape has changed",
				);
			}

			/*
			  The API returns titles, not URLs, so the URL is constructed. Spaces
			  become underscores and everything else is percent-encoded by
			  `encodeURIComponent` — which notably leaves `(` and `)` alone, and
			  article titles are full of them.
			*/
			const results = (hits as SearchHit[]).flatMap((hit) => {
				if (typeof hit.title !== "string" || !hit.title.trim()) return [];
				const slug = encodeURIComponent(hit.title.trim().replace(/ /g, "_"));
				return [{ url: `${articleBase}${slug}`, title: hit.title }];
			});

			return normaliseCandidates(results, "wikipedia", limit);
		},
	};
}
