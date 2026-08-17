import { createHash } from "node:crypto";

/**
 * One canonical form for a query, used as the key for the query cache, the
 * query log, and `query_memory.normalized_query`.
 *
 * Interior punctuation is kept. "c++" and "c" are different questions, and a
 * normaliser that cannot tell them apart makes the cache answer one with the
 * other's results.
 */
export function normalizeQuery(query: string): string {
	return query
		.normalize("NFKC")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[?!.,;:]+$/, "");
}

/** Short, stable, and not reversible into the query it came from. */
export function queryHash(normalized: string): string {
	return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

export function keyFor(query: string): { normalized: string; hash: string } {
	const normalized = normalizeQuery(query);
	return { normalized, hash: queryHash(normalized) };
}

/**
 * The host, verbatim — not eTLD+1.
 *
 * `docs.example.com` and `example.com` are different publishers as far as this
 * system is concerned, because a capability manifest at one is not a claim
 * about the other. Collapsing them would let any subdomain speak for the
 * apex.
 */
export function domainOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/**
 * Strips the fragment and the tracking parameters that make two identical
 * pages look like two pages. Deliberately conservative: an unknown parameter
 * is kept, because dropping one that selects content silently merges two
 * different pages into one index entry.
 */
const TRACKING = new Set([
	"utm_source",
	"utm_medium",
	"utm_campaign",
	"utm_term",
	"utm_content",
	"utm_id",
	"gclid",
	"fbclid",
	"msclkid",
	"mc_cid",
	"mc_eid",
	"ref",
	"ref_src",
]);

export function canonicalizeUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return raw;
	}

	url.hash = "";
	for (const key of [...url.searchParams.keys()]) {
		if (TRACKING.has(key.toLowerCase())) url.searchParams.delete(key);
	}
	// Sorted, so ?a=1&b=2 and ?b=2&a=1 are one document rather than two.
	url.searchParams.sort();

	if (
		(url.protocol === "https:" && url.port === "443") ||
		(url.protocol === "http:" && url.port === "80")
	) {
		url.port = "";
	}
	if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
		url.pathname = url.pathname.slice(0, -1);
	}

	return url.toString();
}
