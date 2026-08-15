import { createHash } from "node:crypto";

/**
 * The form of a query that the cache and the log both key on.
 *
 * One function, used by both, because the two must agree: a cache that
 * normalises differently from the log produces a hit rate measured against a
 * different population than the demand curve it is supposed to explain.
 *
 * What it does, and each is load-bearing:
 *
 * - **Lowercase and collapse whitespace.** `"  Best   LAPTOP "` and
 *   `"best laptop"` are one query and should cost one upstream call.
 * - **Unicode NFKC.** Full-width and compatibility characters arrive from
 *   mobile keyboards and pasted text; without folding them, visually identical
 *   queries miss each other.
 * - **Strip trailing punctuation only.** `"what is ADS?"` and `"what is ADS"`
 *   are the same question. Interior punctuation is kept, because `C++`,
 *   `node.js` and `AT&T` are not the same tokens without it — this is the
 *   difference between normalising and mangling.
 *
 * Deliberately *not* stemmed, stop-worded or reordered. Those change what was
 * asked; this only changes how it was typed.
 */
export function normalizeQuery(query: string): string {
	return query
		.normalize("NFKC")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[?!.,;:]+$/u, "")
		.trim();
}

/**
 * The cache key. SHA-256 of the normalised query, hex, first 32 chars.
 *
 * Hashed rather than used directly because the column is a primary key
 * component and queries are unbounded in length — a 4KB paste should not be a
 * 4KB index entry. 128 bits of a SHA-256 is far past collision-relevant for a
 * key space this size.
 *
 * The *normalised text* is stored alongside it in both tables, so nothing here
 * makes the log unreadable: the hash is the key, the text is the data.
 */
export function queryHash(normalized: string): string {
	return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

/** Both at once, since every caller wants both. */
export function keyFor(query: string): { normalized: string; hash: string } {
	const normalized = normalizeQuery(query);
	return { normalized, hash: queryHash(normalized) };
}
