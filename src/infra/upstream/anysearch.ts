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
 * AnySearch.
 *
 * The second vendor, after Brave (payment card we could not use) and Google
 * Programmable Search (no longer searches the whole web) were both ruled out.
 *
 * Unlike the other two providers here, the request and response shapes below
 * were **read off a real call before this file was written**, not from
 * documentation. That ordering is deliberate: the last shape taken on trust was
 * the egress client's `accept-encoding`, whose tests passed against the same
 * assumption they encoded and which cost most of a corpus before a live run
 * caught it.
 *
 * Verified 2026-08-13:
 *
 *   POST /v1/search   Authorization: Bearer …
 *   → 200 {"code":0,"message":"Success.","request_id":"…",
 *          "data":{"results":[{"title","url","snippet","content"}]}}
 *   → 400 {"code":-1,"message":"Query is required."}
 *   → 401 {"code":-1,"message":"Invalid API key."}
 *
 * Two shape details that are easy to get wrong and were confirmed rather than
 * assumed: results are nested under `data`, not at the top level; and failures
 * carry a real HTTP status *as well as* `code: -1`, so this is not one of the
 * APIs that answers 200 for everything. `code` is checked anyway — it costs a
 * line, and an envelope that carries a status usually means to use it.
 *
 * `snippet` and `content` are both discarded. AnySearch will hand back page
 * text, and taking it would mean citing something we never fetched — the whole
 * argument for the read-and-extract pipeline. `Candidate` has nowhere to put it,
 * which is what makes that hard to undo by accident.
 */

const ENDPOINT = "https://api.anysearch.com/v1/search";

/** The API documents `max_results` as 1–20 and rejects values outside it. */
const MAX_PER_REQUEST = 20;

type AnySearchResult = { url?: unknown; title?: unknown };

/** `endpoint` is a constructor parameter, not configuration — see the Tavily provider. */
export function createAnySearchProvider(
	apiKey: string,
	client: EgressClient,
	endpoint: string = ENDPOINT,
): SearchProvider {
	return {
		name: "anysearch",

		async search(
			query: string,
			options: SearchOptions = {},
		): Promise<Candidate[]> {
			const limit = Math.min(
				Math.max(options.limit ?? DEFAULT_LIMIT, 1),
				MAX_PER_REQUEST,
			);

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
						format: "json",
					}),
				});
			} catch (error) {
				throw new UpstreamError(
					"anysearch",
					error instanceof Error ? error.message : String(error),
				);
			}

			let payload: {
				code?: unknown;
				message?: unknown;
				data?: { results?: unknown };
			};
			try {
				payload = JSON.parse(response.body.toString("utf8")) as typeof payload;
			} catch {
				throw new UpstreamError(
					"anysearch",
					`HTTP ${response.status}, and the body was not JSON`,
					response.status,
				);
			}

			if (response.status !== 200) {
				// The message is the useful half — "Invalid API key." says more than
				// the status does, and it is what a person reads in the trace.
				const message =
					typeof payload.message === "string"
						? payload.message
						: `HTTP ${response.status}`;
				throw new UpstreamError("anysearch", message, response.status);
			}

			if (typeof payload.code === "number" && payload.code !== 0) {
				throw new UpstreamError(
					"anysearch",
					`code ${payload.code}: ${
						typeof payload.message === "string" ? payload.message : "no message"
					}`,
					response.status,
				);
			}

			// A missing `data.results` is a changed contract, not an empty result
			// set. Conflating them turns a vendor breaking their API into "no
			// answer for that query", which is the quietest possible outage.
			const results = payload.data?.results;
			if (!Array.isArray(results)) {
				throw new UpstreamError(
					"anysearch",
					"response had no `data.results` array — the API shape has changed",
				);
			}

			return normaliseCandidates(
				results as AnySearchResult[],
				"anysearch",
				limit,
			);
		},
	};
}
