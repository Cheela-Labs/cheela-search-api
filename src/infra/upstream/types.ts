/**
 * The upstream search interface.
 *
 * One shape, two vendors behind it, switchable by config. Not "designed for
 * two" — two, wired, because a single search vendor is a single point of both
 * cost and termination, and the second one never gets added later, under
 * pressure, when the first changes its pricing.
 *
 * ## There is no snippet field, and that is the point
 *
 * Every one of these APIs returns a snippet, and this type deliberately drops
 * it. The architecture's central claim about quality is that we compose from
 * pages we fetched and read, never from the provider's summary — a snippet is a
 * summary of a summary, and citing one means citing something we never
 * verified.
 *
 * Keeping the field "just for debugging" is how that erodes: it would be one
 * small change away from a cheap reranking signal, and one more from a fallback
 * when extraction fails. A value that is not carried cannot be used by
 * accident, which is the same argument that keeps a user id out of
 * `web.query_log`.
 */

export type Candidate = {
	url: string;
	/** For logs and for the sources rail before extraction finishes. Never cited. */
	title: string | null;
	/** 1-based position as this provider ranked it. */
	rank: number;
	/** Which provider produced it, so a bad result set can be attributed. */
	provider: string;
};

export type SearchOptions = {
	/** Upper bound on candidates. Providers may return fewer, never more. */
	limit?: number;
	signal?: AbortSignal;
};

export interface SearchProvider {
	readonly name: string;
	search(query: string, options?: SearchOptions): Promise<Candidate[]>;
}

/** Thrown by a provider so the rotation can tell "vendor is down" from a bug. */
export class UpstreamError extends Error {
	readonly provider: string;
	readonly status: number | null;

	constructor(provider: string, detail: string, status: number | null = null) {
		super(`${provider}: ${detail}`);
		this.name = "UpstreamError";
		this.provider = provider;
		this.status = status;
	}
}

export const DEFAULT_LIMIT = 10;

/**
 * Drops anything that is not a usable http(s) URL, de-duplicates, and renumbers.
 *
 * Shared because every provider needs it and each one would otherwise get its
 * own slightly different version. Vendors do return junk — relative URLs,
 * `javascript:` entries, the same page twice under different tracking
 * parameters — and the egress client would refuse most of it anyway. Refusing it
 * here means the refusal is not counted as a retrieval failure, which would
 * otherwise make the extraction success rate a measure of vendor hygiene.
 */
export function normaliseCandidates(
	raw: readonly { url?: unknown; title?: unknown }[],
	provider: string,
	limit: number,
): Candidate[] {
	const seen = new Set<string>();
	const out: Candidate[] = [];

	for (const item of raw) {
		if (out.length >= limit) break;
		if (typeof item.url !== "string") continue;

		let parsed: URL;
		try {
			parsed = new URL(item.url);
		} catch {
			continue;
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;

		// The fragment never changes what a server returns, so two results
		// differing only by anchor are one page.
		parsed.hash = "";
		const key = parsed.toString();
		if (seen.has(key)) continue;
		seen.add(key);

		out.push({
			url: key,
			title:
				typeof item.title === "string" && item.title.trim()
					? item.title.trim()
					: null,
			rank: out.length + 1,
			provider,
		});
	}

	return out;
}
