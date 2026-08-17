import type { EgressClient } from "../../infra/egress/client.js";
import { config } from "../../shared/config.js";
import { canonicalizeUrl, domainOf } from "../../shared/normalize.js";

/**
 * Stage B: the rented index.
 *
 * Tavily and AnySearch, called in parallel behind the TDS's 800ms soft
 * timeout. They are bootstrap providers — every result they return is fed
 * into the indexing pipeline, so the same query asked again is answered from
 * Vespa and costs nothing.
 */

export type Candidate = {
	url: string;
	title: string;
	snippet: string;
	/** 1-based, within this provider's own list. */
	rank: number;
	provider: string;
};

export type SearchProvider = {
	name: string;
	search(
		query: string,
		options: { limit?: number; signal?: AbortSignal },
	): Promise<Candidate[]>;
};

export class ProviderError extends Error {
	readonly provider: string;
	constructor(provider: string, detail: string) {
		super(`${provider}: ${detail}`);
		this.name = "ProviderError";
		this.provider = provider;
	}
}

/**
 * Normalises whatever a provider returned into candidates we can fuse.
 *
 * Every provider's output passes through here, which is where the URL is
 * canonicalised — so the same page returned by two providers fuses as one
 * document rather than as two that happen to look alike.
 */
export function normalise(
	raw: unknown,
	provider: string,
	limit: number,
): Candidate[] {
	if (!Array.isArray(raw)) return [];

	const seen = new Set<string>();
	const candidates: Candidate[] = [];

	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const url = typeof record.url === "string" ? record.url : "";
		if (!url) continue;

		// http(s) only, and canonical, before deduplication — otherwise the
		// same page with a utm parameter counts twice and looks like agreement.
		let canonical: string;
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
			canonical = canonicalizeUrl(url);
		} catch {
			continue;
		}

		if (seen.has(canonical)) continue;
		seen.add(canonical);

		candidates.push({
			url: canonical,
			title: typeof record.title === "string" ? record.title.trim() : "",
			snippet:
				typeof record.content === "string"
					? record.content.trim()
					: typeof record.snippet === "string"
						? record.snippet.trim()
						: typeof record.description === "string"
							? record.description.trim()
							: "",
			// Renumbered after filtering, so ranks are contiguous and RRF does
			// not silently reward a provider whose junk we dropped.
			rank: candidates.length + 1,
			provider,
		});

		if (candidates.length >= limit) break;
	}

	return candidates;
}

export function createTavily(
	apiKey: string,
	client: EgressClient,
	endpoint = "https://api.tavily.com/search",
): SearchProvider {
	return {
		name: "tavily",
		async search(query, options) {
			const limit = options.limit ?? 10;
			const response = await client.fetch(endpoint, {
				method: "POST",
				signal: options.signal,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					api_key: apiKey,
					query,
					max_results: limit,
					search_depth: "basic",
				}),
			});

			if (response.status >= 400) {
				throw new ProviderError("tavily", `status ${response.status}`);
			}

			try {
				const parsed = JSON.parse(response.body.toString("utf8"));
				return normalise(parsed.results, "tavily", limit);
			} catch {
				throw new ProviderError("tavily", "unparseable response");
			}
		},
	};
}

export function createAnySearch(
	apiKey: string,
	client: EgressClient,
	endpoint = "https://api.anysearch.com/v1/search",
): SearchProvider {
	return {
		name: "anysearch",
		async search(query, options) {
			const limit = options.limit ?? 10;
			const response = await client.fetch(endpoint, {
				method: "POST",
				signal: options.signal,
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({ query, limit }),
			});

			if (response.status >= 400) {
				throw new ProviderError("anysearch", `status ${response.status}`);
			}

			try {
				const parsed = JSON.parse(response.body.toString("utf8"));
				// Results have been seen at both the top level and under `data`.
				const results = parsed.data?.results ?? parsed.results ?? parsed.data;
				return normalise(results, "anysearch", limit);
			} catch {
				throw new ProviderError("anysearch", "unparseable response");
			}
		},
	};
}

export type FanoutResult = {
	lists: { provider: string; candidates: Candidate[] }[];
	/** Providers that failed or timed out. Reported, never thrown. */
	failed: string[];
};

/**
 * Calls every provider at once and returns whatever arrived in time.
 *
 * The TDS calls 800ms a *soft* timeout, and the distinction carries the
 * design: a provider that misses it has not errored, it has simply not
 * contributed to this query. The failure table says "Tavily timeout →
 * continue", so nothing here rejects — a caller that had to catch this would
 * eventually catch it by returning no results at all.
 */
export async function fanout(
	providers: SearchProvider[],
	query: string,
	options: { limit?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<FanoutResult> {
	const timeoutMs = options.timeoutMs ?? config.EXTERNAL_TIMEOUT_MS;

	const settled = await Promise.all(
		providers.map(async (provider) => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			const onAbort = () => controller.abort();
			options.signal?.addEventListener("abort", onAbort, { once: true });

			try {
				const candidates = await provider.search(query, {
					limit: options.limit,
					signal: controller.signal,
				});
				return { provider: provider.name, candidates, ok: true };
			} catch {
				return { provider: provider.name, candidates: [], ok: false };
			} finally {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
			}
		}),
	);

	return {
		lists: settled
			.filter((entry) => entry.ok && entry.candidates.length > 0)
			.map(({ provider, candidates }) => ({ provider, candidates })),
		failed: settled.filter((entry) => !entry.ok).map((entry) => entry.provider),
	};
}

/** Domains seen in a candidate list, for capability lookup and the query log. */
export function domainsOf(candidates: Candidate[]): string[] {
	return [
		...new Set(candidates.map((candidate) => domainOf(candidate.url))),
	].filter(Boolean);
}
