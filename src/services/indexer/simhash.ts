import { createHash } from "node:crypto";

/**
 * SimHash, for the TDS's near-duplicate detection step.
 *
 * An exact content hash catches only byte-identical pages, and the duplicates
 * that actually fill an index are not byte-identical: the same article on a
 * syndication partner, the same documentation page with a different sidebar,
 * the same product with a different tracking parameter. SimHash gives those a
 * *similar* fingerprint, so "how different is this from what we have" becomes
 * a Hamming distance rather than a comparison of full texts.
 *
 * 64 bits, held as a BigInt because JavaScript's number type cannot represent
 * one. Stored in Postgres as a signed bigint — the sign bit is data, and any
 * reader that treats the value as a magnitude will be wrong for half of them.
 */

const BITS = 64n;

/** Shingles rather than single words: word order carries most of the signal. */
export function shingles(text: string, size = 3): string[] {
	const words = text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);

	if (words.length < size) return words.length ? [words.join(" ")] : [];

	const out: string[] = [];
	for (let index = 0; index + size <= words.length; index += 1) {
		out.push(words.slice(index, index + size).join(" "));
	}
	return out;
}

function hash64(value: string): bigint {
	// The first 8 bytes of SHA-256. A cheaper non-cryptographic hash would do,
	// but this one is already in the standard library and the cost is dwarfed
	// by the fetch that produced the text.
	const digest = createHash("sha256").update(value).digest();
	return digest.readBigUInt64BE(0);
}

export function simhash(text: string): bigint {
	const features = shingles(text);
	if (features.length === 0) return 0n;

	// One counter per bit: every feature votes for each bit's value, and the
	// majority wins. That is what makes the result stable under small edits —
	// changing a sentence changes a few votes, not the outcome of most bits.
	const votes = new Array<number>(64).fill(0);

	for (const feature of features) {
		const value = hash64(feature);
		for (let bit = 0n; bit < BITS; bit += 1n) {
			votes[Number(bit)] += (value >> bit) & 1n ? 1 : -1;
		}
	}

	let result = 0n;
	for (let bit = 0; bit < 64; bit += 1) {
		if (votes[bit] > 0) result |= 1n << BigInt(bit);
	}
	return result;
}

export function hammingDistance(a: bigint, b: bigint): number {
	let difference = a ^ b;
	let count = 0;
	while (difference) {
		difference &= difference - 1n;
		count += 1;
	}
	return count;
}

/**
 * Three bits out of 64 is the usual threshold for "the same document".
 *
 * Chosen conservatively: at this distance the false-positive rate on ordinary
 * prose is low, and the cost of being wrong is asymmetric. Dropping a
 * genuinely different page as a duplicate makes it permanently unfindable;
 * keeping a duplicate merely wastes a row.
 */
export const NEAR_DUPLICATE_DISTANCE = 3;

export function isNearDuplicate(
	a: bigint,
	b: bigint,
	threshold = NEAR_DUPLICATE_DISTANCE,
): boolean {
	return hammingDistance(a, b) <= threshold;
}

/** Postgres has no unsigned 64-bit integer, so the value is stored signed. */
export function toSigned(value: bigint): bigint {
	return BigInt.asIntN(64, value);
}

export function fromSigned(value: bigint): bigint {
	return BigInt.asUintN(64, value);
}
