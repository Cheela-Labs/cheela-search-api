/**
 * Which IP addresses this service is allowed to connect to.
 *
 * This is the highest-severity file in the repository, and the reason is
 * specific to where it runs. On Cloud Run, `169.254.169.254` is the metadata
 * server, and it hands out access tokens for the service account the revision
 * runs as. This service fetches attacker-influenceable URLs from two
 * directions — result URLs out of an index anyone can try to manipulate, and
 * endpoint addresses out of capability manifests written by strangers — so an
 * SSRF here is credential theft, not an internal port scan.
 *
 * The policy is an allowlist by exclusion: everything is permitted except the
 * ranges below, which are every IPv4 and IPv6 range that is not a public
 * unicast address on the internet.
 */

export type AddressVerdict =
	| { allowed: true }
	| { allowed: false; reason: string };

const ALLOWED: AddressVerdict = { allowed: true };
const deny = (reason: string): AddressVerdict => ({ allowed: false, reason });

type Range = { name: string; base: number; bits: number };

const range = (name: string, cidr: string): Range => {
	const [address, prefix] = cidr.split("/");
	const parsed = parseIPv4(address);
	if (parsed === null) throw new Error(`unparseable range: ${cidr}`);
	return { name, base: parsed, bits: Number(prefix) };
};

/**
 * Every non-public IPv4 range, named. Named rather than expressed as one
 * clever predicate because the next person to read this needs to be able to
 * check the list against RFC 6890 line by line.
 */
const DENIED_V4: Range[] = [
	range("this-network", "0.0.0.0/8"),
	range("private", "10.0.0.0/8"),
	range("shared-cgnat", "100.64.0.0/10"),
	range("loopback", "127.0.0.0/8"),
	range("link-local", "169.254.0.0/16"),
	range("private", "172.16.0.0/12"),
	range("ietf-protocol", "192.0.0.0/24"),
	range("test-net-1", "192.0.2.0/24"),
	range("6to4-relay", "192.88.99.0/24"),
	range("private", "192.168.0.0/16"),
	range("benchmarking", "198.18.0.0/15"),
	range("test-net-2", "198.51.100.0/24"),
	range("test-net-3", "203.0.113.0/24"),
	range("multicast", "224.0.0.0/4"),
	range("reserved", "240.0.0.0/4"),
];

/**
 * Inside `link-local` already, and denied by it. Called out separately so the
 * log line says what actually happened: "blocked: gcp-metadata" is an
 * incident, "blocked: link-local" is a broken link.
 */
const METADATA_V4 = 0xa9_fe_a9_fe; // 169.254.169.254

/**
 * Strict IPv4 parsing. Four decimal octets, no leading zeros, nothing else.
 *
 * The leading-zero rule is the point. `inet_aton` and several libraries read
 * `0177.0.0.1` as octal — 127.0.0.1 — so a checker that parses leniently and a
 * connector that parses differently disagree about which host is being
 * contacted, and the disagreement is the vulnerability. Anything unusual is
 * rejected rather than interpreted.
 */
export function parseIPv4(address: string): number | null {
	const parts = address.split(".");
	if (parts.length !== 4) return null;

	let value = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		if (part.length > 1 && part.startsWith("0")) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		value = value * 256 + octet;
	}
	return value >>> 0;
}

function inRange(value: number, { base, bits }: Range): boolean {
	if (bits === 0) return true;
	const mask = (0xff_ff_ff_ff << (32 - bits)) >>> 0;
	return (value & mask) >>> 0 === (base & mask) >>> 0;
}

function classifyV4(value: number): AddressVerdict {
	if (value === METADATA_V4) return deny("gcp-metadata");
	if (value === 0xff_ff_ff_ff) return deny("broadcast");
	for (const entry of DENIED_V4) {
		if (inRange(value, entry)) return deny(entry.name);
	}
	return ALLOWED;
}

/**
 * Expands an IPv6 address to its sixteen bytes, or null if it is not one.
 *
 * Hand-rolled rather than delegated because the interesting cases are the
 * embedded-IPv4 forms below, and those need the bytes.
 */
function parseIPv6(address: string): number[] | null {
	let text = address;
	// A zone index (fe80::1%eth0) is not part of the address.
	const zone = text.indexOf("%");
	if (zone !== -1) text = text.slice(0, zone);

	if (!text.includes(":")) return null;

	// A trailing dotted quad, as in ::ffff:127.0.0.1 or 64:ff9b::192.0.2.1.
	let tail: number[] | null = null;
	const lastColon = text.lastIndexOf(":");
	const suffix = text.slice(lastColon + 1);
	if (suffix.includes(".")) {
		const embedded = parseIPv4(suffix);
		if (embedded === null) return null;
		tail = [
			(embedded >>> 24) & 0xff,
			(embedded >>> 16) & 0xff,
			(embedded >>> 8) & 0xff,
			embedded & 0xff,
		];
		// Drop the quad and parse only the groups before it, with `total` set to
		// 6 below. An earlier version substituted "0:0" for the quad instead,
		// which added two groups the padding calculation then counted as real —
		// so ::ffff:127.0.0.1 assembled with the ffff marker at bytes 6-7
		// instead of 10-11, failed the IPv4-mapped test, and was *allowed*.
		// test/egress/addresses.ts covers that case for that reason.
		let head = text.slice(0, lastColon);
		// We cut into a "::", so put the second colon back.
		if (head.endsWith(":")) head += ":";
		text = head;
	}

	const halves = text.split("::");
	if (halves.length > 2) return null;

	const toGroups = (part: string): number[] | null => {
		if (part === "") return [];
		const groups: number[] = [];
		for (const piece of part.split(":")) {
			if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
			groups.push(Number.parseInt(piece, 16));
		}
		return groups;
	};

	const head = toGroups(halves[0]);
	const rest = halves.length === 2 ? toGroups(halves[1]) : [];
	if (head === null || rest === null) return null;

	const total = tail ? 6 : 8;
	let groups: number[];
	if (halves.length === 2) {
		const missing = total - head.length - rest.length;
		if (missing < 0) return null;
		groups = [...head, ...new Array(missing).fill(0), ...rest];
	} else {
		groups = head;
		if (groups.length !== total) return null;
	}
	if (groups.length !== total) return null;

	const bytes: number[] = [];
	for (const group of groups) {
		bytes.push((group >>> 8) & 0xff, group & 0xff);
	}
	if (tail) bytes.push(...tail);
	return bytes.length === 16 ? bytes : null;
}

const asV4 = (bytes: number[], offset: number): number =>
	((bytes[offset] << 24) |
		(bytes[offset + 1] << 16) |
		(bytes[offset + 2] << 8) |
		bytes[offset + 3]) >>>
	0;

function classifyV6(bytes: number[]): AddressVerdict {
	const isZero = (from: number, to: number) =>
		bytes.slice(from, to).every((byte) => byte === 0);

	// `::` and `::1` first. Both also match the deprecated IPv4-compatible
	// shape below, which would unwrap ::1 to 0.0.0.1 and report it as
	// "this-network" — still blocked, but the wrong sentence in the log.
	if (isZero(0, 16)) return deny("unspecified");
	if (isZero(0, 15) && bytes[15] === 1) return deny("loopback");

	// ::ffff:a.b.c.d — an IPv4 address wearing an IPv6 costume. Unwrapped and
	// re-checked against the v4 table, because ::ffff:127.0.0.1 reaches
	// exactly what 127.0.0.1 reaches.
	if (isZero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
		return classifyV4(asV4(bytes, 12));
	}
	// ::a.b.c.d, the deprecated compatible form. Same reasoning.
	if (isZero(0, 12) && !isZero(12, 16)) {
		return classifyV4(asV4(bytes, 12));
	}
	// 2002:a.b.c.d::/16 — 6to4 embeds the v4 address it tunnels to.
	if (bytes[0] === 0x20 && bytes[1] === 0x02) {
		const embedded = classifyV4(asV4(bytes, 2));
		if (!embedded.allowed) return deny(`6to4:${embedded.reason}`);
	}
	// 64:ff9b::/96 — NAT64, likewise.
	if (
		bytes[0] === 0x00 &&
		bytes[1] === 0x64 &&
		bytes[2] === 0xff &&
		bytes[3] === 0x9b &&
		isZero(4, 12)
	) {
		const embedded = classifyV4(asV4(bytes, 12));
		if (!embedded.allowed) return deny(`nat64:${embedded.reason}`);
	}

	if ((bytes[0] & 0xfe) === 0xfc) return deny("unique-local");
	if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80)
		return deny("link-local");
	if (bytes[0] === 0xff) return deny("multicast");

	return ALLOWED;
}

/**
 * The one entry point. Anything that is not a public unicast address, or that
 * cannot be parsed with certainty, is refused.
 */
export function classifyAddress(address: string): AddressVerdict {
	const v4 = parseIPv4(address);
	if (v4 !== null) return classifyV4(v4);

	const v6 = parseIPv6(address);
	if (v6 !== null) return classifyV6(v6);

	// Not an address we can reason about. Refusing is the only safe answer:
	// "I could not tell what this is" must never mean "so I connected to it".
	return deny("unparseable");
}
