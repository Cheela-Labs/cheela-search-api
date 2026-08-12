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
 * Google Programmable Search, via the Custom Search JSON API.
 *
 * Chosen as the second vendor for a practical reason rather than a technical
 * one: it bills through a GCP project that already has a working payment
 * method, which is the constraint that ruled out the obvious alternatives.
 *
 * ⚠ Same caveat as the Tavily provider — shapes written from documentation and
 * tested against a fixture asserting the same shapes. Reconcile against a real
 * response.
 *
 * Two limits worth knowing before this is relied on:
 *
 * - **`num` caps at 10 per request.** Asking for more is an error, not a
 *   truncation, so the limit is clamped here rather than passed through.
 * - **100 queries/day on the free tier.** That is a development budget, not a
 *   production one. When it runs out the API returns 429, which the rotation
 *   treats as this provider being down — correct behaviour, and worth
 *   recognising in a log before somebody debugs it as a bug.
 *
 * The search engine must be configured to search the entire web; a Programmable
 * Search Engine restricted to a site list returns almost nothing here and looks
 * exactly like a broken query.
 */

const ENDPOINT = "https://www.googleapis.com/customsearch/v1";

/** The API rejects `num` above this outright. */
const MAX_PER_REQUEST = 10;

type CseItem = { link?: unknown; title?: unknown };

/** `endpoint` is a constructor parameter, not configuration — see the Tavily provider. */
export function createGoogleCseProvider(
	apiKey: string,
	engineId: string,
	client: EgressClient,
	endpoint: string = ENDPOINT,
): SearchProvider {
	return {
		name: "google-cse",

		async search(
			query: string,
			options: SearchOptions = {},
		): Promise<Candidate[]> {
			const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_PER_REQUEST);

			const url = new URL(endpoint);
			url.searchParams.set("key", apiKey);
			url.searchParams.set("cx", engineId);
			url.searchParams.set("q", query);
			url.searchParams.set("num", String(limit));

			let response: Awaited<ReturnType<EgressClient["fetch"]>>;
			try {
				response = await client.fetch(url.toString(), {
					headers: { accept: "application/json" },
				});
			} catch (error) {
				throw new UpstreamError(
					"google-cse",
					error instanceof Error ? error.message : String(error),
				);
			}

			if (response.status !== 200) {
				throw new UpstreamError(
					"google-cse",
					response.status === 429
						? "quota exhausted (100/day on the free tier)"
						: `HTTP ${response.status}`,
					response.status,
				);
			}

			let payload: { items?: unknown };
			try {
				payload = JSON.parse(response.body.toString("utf8")) as {
					items?: unknown;
				};
			} catch {
				throw new UpstreamError("google-cse", "response was not JSON");
			}

			// Unlike Tavily's, a missing `items` here is legitimate: the API omits
			// the key entirely when a query matched nothing. Only a present-but-
			// wrong-typed `items` is a contract change.
			if (payload.items === undefined) return [];
			if (!Array.isArray(payload.items)) {
				throw new UpstreamError(
					"google-cse",
					"`items` was present but not an array — the API shape has changed",
				);
			}

			return normaliseCandidates(
				(payload.items as CseItem[]).map((item) => ({
					url: item.link,
					title: item.title,
				})),
				"google-cse",
				limit,
			);
		},
	};
}
