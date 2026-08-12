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
 * Tavily.
 *
 * ⚠ The request and response shapes here were written from documentation, not
 * from a live call, and this file's tests exercise them against a fixture that
 * asserts the same shape — so a shape that is wrong passes the suite and fails
 * in production. Reconcile against one real response before trusting it; the
 * parsing below is deliberately defensive so a mismatch surfaces as a legible
 * `UpstreamError` rather than a crash or, worse, an empty result set that looks
 * like a query nobody had an answer for.
 *
 * `include_answer` and `include_raw_content` are off on purpose. Tavily will
 * happily compose an answer and return page text, and taking either would mean
 * shipping somebody else's summary as ours — the thing the whole fetch-and-read
 * pipeline exists to avoid. We want URLs.
 */

const ENDPOINT = "https://api.tavily.com/search";

type TavilyResult = { url?: unknown; title?: unknown };

/**
 * `endpoint` is a constructor parameter and not configuration, the same way the
 * egress client's policy hooks are: tests point it at a fixture server, and no
 * environment variable can move production traffic to a host nobody reviewed.
 */
export function createTavilyProvider(
	apiKey: string,
	client: EgressClient,
	endpoint: string = ENDPOINT,
): SearchProvider {
	return {
		name: "tavily",

		async search(
			query: string,
			options: SearchOptions = {},
		): Promise<Candidate[]> {
			const limit = options.limit ?? DEFAULT_LIMIT;

			let response: Awaited<ReturnType<EgressClient["fetch"]>>;
			try {
				response = await client.fetch(endpoint, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${apiKey}`,
						accept: "application/json",
					},
					body: JSON.stringify({
						query,
						max_results: limit,
						search_depth: "basic",
						include_answer: false,
						include_raw_content: false,
					}),
				});
			} catch (error) {
				throw new UpstreamError(
					"tavily",
					error instanceof Error ? error.message : String(error),
				);
			}

			if (response.status !== 200) {
				throw new UpstreamError(
					"tavily",
					`HTTP ${response.status}`,
					response.status,
				);
			}

			let payload: { results?: unknown };
			try {
				payload = JSON.parse(response.body.toString("utf8")) as {
					results?: unknown;
				};
			} catch {
				throw new UpstreamError("tavily", "response was not JSON");
			}

			// A missing `results` is a changed contract, not an empty result set.
			// Conflating them would turn a vendor breaking their API into "no
			// answer for that query", which is the quietest possible outage.
			if (!Array.isArray(payload.results)) {
				throw new UpstreamError(
					"tavily",
					"response had no `results` array — the API shape has changed",
				);
			}

			return normaliseCandidates(
				payload.results as TavilyResult[],
				"tavily",
				limit,
			);
		},
	};
}
