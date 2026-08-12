/**
 * Which IP addresses this service is allowed to connect to.
 *
 * The default answer is "public unicast, and nothing else". Everything here is
 * a deny rule because the alternative — an allowlist of the public internet —
 * is not expressible, but the disposition is deny-by-default in spirit: a range
 * whose reachability we have not thought about should end up on this list, not
 * off it.
 *
 * `169.254.169.254` is the reason this file is stricter than a general-purpose
 * fetcher's would be. On Cloud Run that address is the GCP metadata server and
 * it issues access tokens for the service's identity, so an SSRF that reaches
 * it is credential theft rather than an internal port scan. It is covered by
 * the link-local rule below and also called out by name, because a future
 * narrowing of that rule must not silently uncover it.
 *
 * IPv6 is not an afterthought here and cannot be. `::ffff:127.0.0.1` is
 * loopback wearing a v6 costume, `::127.0.0.1` is the deprecated spelling of
 * the same thing, and `2002:7f00:0001::` reaches it through 6to4. Each of the
 * three is unwrapped to the v4 address it embeds and re-checked, because a
 * classifier that only pattern-matches v6 prefixes lets all three through.
 */

import { isIP } from "node:net";

export type AddressVerdict =
	| { allowed: true }
	| { allowed: false; reason: string };

const ALLOWED: AddressVerdict = { allowed: true };

const deny = (reason: string): AddressVerdict => ({ allowed: false, reason });

/** `a.b.c.d` → unsigned 32-bit, or null when it is not a dotted quad. */
function parseIPv4(input: string): number | null {
	const parts = input.split(".");
	if (parts.length !== 4) return null;
	let value = 0;
	for (const part of parts) {
		// Rejects "01" and "1e2" as well as out-of-range: a permissive parser
		// here is its own bypass, since 0177.0.0.1 is 127.0.0.1 to some resolvers.
		if (!/^\d{1,3}$/.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		value = value * 256 + octet;
	}
	return value >>> 0;
}

type Range = { name: string; start: number; end: number };

const v4 = (address: string): number => parseIPv4(address) as number;

/**
 * Ordered only for readability. Named because the name is what the caller sees
 * in the error, and "blocked: link-local" is a diagnosis where "blocked" is a
 * shrug.
 */
const IPV4_DENY: Range[] = [
	{ name: "this-network", start: v4("0.0.0.0"), end: v4("0.255.255.255") },
	{ name: "private", start: v4("10.0.0.0"), end: v4("10.255.255.255") },
	{ name: "shared-cgnat", start: v4("100.64.0.0"), end: v4("100.127.255.255") },
	{ name: "loopback", start: v4("127.0.0.0"), end: v4("127.255.255.255") },
	{ name: "link-local", start: v4("169.254.0.0"), end: v4("169.254.255.255") },
	{ name: "private", start: v4("172.16.0.0"), end: v4("172.31.255.255") },
	{ name: "ietf-protocol", start: v4("192.0.0.0"), end: v4("192.0.0.255") },
	{ name: "test-net-1", start: v4("192.0.2.0"), end: v4("192.0.2.255") },
	{ name: "6to4-relay", start: v4("192.88.99.0"), end: v4("192.88.99.255") },
	{ name: "private", start: v4("192.168.0.0"), end: v4("192.168.255.255") },
	{ name: "benchmarking", start: v4("198.18.0.0"), end: v4("198.19.255.255") },
	{ name: "test-net-2", start: v4("198.51.100.0"), end: v4("198.51.100.255") },
	{ name: "test-net-3", start: v4("203.0.113.0"), end: v4("203.0.113.255") },
	{ name: "multicast", start: v4("224.0.0.0"), end: v4("239.255.255.255") },
	{ name: "reserved", start: v4("240.0.0.0"), end: v4("255.255.255.255") },
];

/** The GCP/AWS/Azure instance metadata address. Covered above; named anyway. */
const METADATA_V4 = v4("169.254.169.254");

function classifyIPv4(value: number, original: string): AddressVerdict {
	if (value === METADATA_V4) {
		return deny(`${original} is the cloud instance metadata endpoint`);
	}
	for (const range of IPV4_DENY) {
		if (value >= range.start && value <= range.end) {
			return deny(`${original} is in a ${range.name} range`);
		}
	}
	return ALLOWED;
}

/** Expands any valid textual IPv6 to its 16 bytes, or null. */
function parseIPv6(input: string): Uint8Array | null {
	// A zone index (`fe80::1%eth0`) is a local-scope artifact; drop it and let
	// the prefix rules judge the address itself.
	const zone = input.indexOf("%");
	const address = zone === -1 ? input : input.slice(0, zone);

	const double = address.indexOf("::");
	const head = double === -1 ? address : address.slice(0, double);
	const tail = double === -1 ? "" : address.slice(double + 2);

	const groups = (segment: string): number[] | null => {
		if (!segment) return [];
		const parts = segment.split(":");
		const out: number[] = [];
		for (const [index, part] of parts.entries()) {
			if (part.includes(".")) {
				// A dotted quad is only legal as the final 32 bits.
				if (index !== parts.length - 1) return null;
				const embedded = parseIPv4(part);
				if (embedded === null) return null;
				out.push((embedded >>> 16) & 0xffff, embedded & 0xffff);
				continue;
			}
			if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
			out.push(Number.parseInt(part, 16));
		}
		return out;
	};

	const front = groups(head);
	const back = groups(tail);
	if (!front || !back) return null;

	let all: number[];
	if (double === -1) {
		if (front.length !== 8) return null;
		all = front;
	} else {
		const fill = 8 - front.length - back.length;
		if (fill < 0) return null;
		all = [...front, ...Array<number>(fill).fill(0), ...back];
	}

	const bytes = new Uint8Array(16);
	for (let i = 0; i < 8; i += 1) {
		bytes[i * 2] = (all[i] as number) >>> 8;
		bytes[i * 2 + 1] = (all[i] as number) & 0xff;
	}
	return bytes;
}

const allZero = (bytes: Uint8Array, from: number, to: number): boolean => {
	for (let i = from; i < to; i += 1) if (bytes[i] !== 0) return false;
	return true;
};

const embeddedV4 = (bytes: Uint8Array, offset: number): number =>
	(((bytes[offset] as number) << 24) |
		((bytes[offset + 1] as number) << 16) |
		((bytes[offset + 2] as number) << 8) |
		(bytes[offset + 3] as number)) >>>
	0;

function classifyIPv6(bytes: Uint8Array, original: string): AddressVerdict {
	// ::ffff:a.b.c.d — an IPv4 address in v6 clothing. Unwrap and judge the v4,
	// or `::ffff:127.0.0.1` walks straight past every prefix rule below.
	if (allZero(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
		return classifyIPv4(embeddedV4(bytes, 12), original);
	}

	// 2002::/16 — 6to4, with the v4 address in bytes 2..5.
	if (bytes[0] === 0x20 && bytes[1] === 0x02) {
		const inner = classifyIPv4(embeddedV4(bytes, 2), original);
		if (!inner.allowed) return inner;
		return deny(`${original} is a 6to4 address`);
	}

	if (allZero(bytes, 0, 15)) {
		if (bytes[15] === 0) return deny(`${original} is the unspecified address`);
		if (bytes[15] === 1) return deny(`${original} is loopback`);
	}

	// ::a.b.c.d — deprecated IPv4-compatible form, and another way to spell
	// loopback if it is not unwrapped.
	if (allZero(bytes, 0, 12)) {
		const inner = classifyIPv4(embeddedV4(bytes, 12), original);
		if (!inner.allowed) return inner;
		return deny(`${original} is an IPv4-compatible address`);
	}

	const first = bytes[0] as number;
	const second = bytes[1] as number;

	if ((first & 0xfe) === 0xfc) return deny(`${original} is unique-local`);
	if (first === 0xfe && (second & 0xc0) === 0x80) {
		return deny(`${original} is link-local`);
	}
	if (first === 0xff) return deny(`${original} is multicast`);
	if (first === 0x01 && (second & 0xfe) === 0x00) {
		return deny(`${original} is in the discard range`);
	}
	if (first === 0x20 && second === 0x01) {
		// 2001:db8::/32 documentation, and 64:ff9b::/96 NAT64 lives elsewhere.
		if (bytes[2] === 0x0d && bytes[3] === 0xb8) {
			return deny(`${original} is documentation-only`);
		}
	}
	if (
		first === 0x00 &&
		second === 0x64 &&
		bytes[2] === 0xff &&
		bytes[3] === 0x9b
	) {
		return deny(`${original} is a NAT64 translation prefix`);
	}

	return ALLOWED;
}

/**
 * Judges one resolved address.
 *
 * Takes an IP, never a hostname — resolution is the caller's job precisely so
 * that the address which gets judged is the address which gets connected to.
 */
export function classifyAddress(address: string): AddressVerdict {
	const family = isIP(address);
	if (family === 4) {
		const value = parseIPv4(address);
		if (value === null) return deny(`${address} is not a usable address`);
		return classifyIPv4(value, address);
	}
	if (family === 6) {
		const bytes = parseIPv6(address);
		if (bytes === null) return deny(`${address} is not a usable address`);
		return classifyIPv6(bytes, address);
	}
	return deny(`${address} is not an IP address`);
}
