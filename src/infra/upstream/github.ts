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
 * GitHub repository search.
 *
 * ## Why repositories and not code
 *
 * Code search would be the better retriever for a query like
 * `rust borrow checker rules for mutable references`, and it is not available:
 * GitHub's code search API requires authentication *and* is restricted in ways
 * repository search is not. Repository search reaches the thing that actually
 * answers these queries anyway — the README — because a repository's README is
 * what its landing page renders, and that page extracts cleanly.
 *
 * `pgvector hnsw index parameters` is the worked example. The answer,
 * `ef_construction`, is in pgvector's README, and the repository result is a
 * page we are allowed to fetch and can read.
 *
 * ## Token-gated, and that is not optional
 *
 * Unauthenticated search is **10 requests per minute**, shared across the whole
 * Cloud Run service. Wired without a token this would spend its budget in six
 * seconds of ordinary traffic and then contribute nothing but `rate-limited`
 * failures to the retrieval statistics — actively worse than being absent,
 * because it would make the extraction rate look like an extraction problem. So
 * the provider is only built when `GITHUB_TOKEN` is set, which takes it to 30
 * per minute.
 *
 * That is still a real ceiling. It is a specialist, fanned out alongside the
 * general vendors rather than depended on, and a rate-limit response is a
 * failure this provider reports and the merge ignores.
 */

const ENDPOINT = "https://api.github.com/search/repositories";

type Repository = { html_url?: unknown; full_name?: unknown };

export function createGitHubProvider(
	token: string,
	client: EgressClient,
	endpoint: string = ENDPOINT,
): SearchProvider {
	return {
		name: "github",

		async search(
			query: string,
			options: SearchOptions = {},
		): Promise<Candidate[]> {
			const limit = options.limit ?? DEFAULT_LIMIT;

			const url = new URL(endpoint);
			url.searchParams.set("q", query);
			url.searchParams.set("per_page", String(limit));
			// By relevance, which is the default and is stated anyway: the
			// alternative orderings are by stars and by recency, and both would make
			// this a popularity retriever rather than a search one.
			url.searchParams.set("sort", "best-match");

			let response: Awaited<ReturnType<EgressClient["fetch"]>>;
			try {
				response = await client.fetch(url.toString(), {
					headers: {
						accept: "application/vnd.github+json",
						authorization: `Bearer ${token}`,
						"x-github-api-version": "2022-11-28",
					},
					...(options.signal ? { signal: options.signal } : {}),
				});
			} catch (error) {
				throw new UpstreamError(
					"github",
					error instanceof Error ? error.message : String(error),
				);
			}

			// 403 and 429 both mean rate limited here, and saying so is the point:
			// a bare "HTTP 403" from this provider reads as a credential problem and
			// sends somebody to check the token that is working fine.
			if (response.status === 403 || response.status === 429) {
				throw new UpstreamError(
					"github",
					`rate limited (HTTP ${response.status})`,
					response.status,
				);
			}

			if (response.status !== 200) {
				throw new UpstreamError(
					"github",
					`HTTP ${response.status}`,
					response.status,
				);
			}

			let payload: { items?: unknown };
			try {
				payload = JSON.parse(response.body.toString("utf8")) as {
					items?: unknown;
				};
			} catch {
				throw new UpstreamError("github", "response was not JSON");
			}

			if (!Array.isArray(payload.items)) {
				throw new UpstreamError(
					"github",
					"response had no `items` array — the API shape has changed",
				);
			}

			const results = (payload.items as Repository[]).map((item) => ({
				url: item.html_url,
				title: item.full_name,
			}));

			return normaliseCandidates(results, "github", limit);
		},
	};
}
