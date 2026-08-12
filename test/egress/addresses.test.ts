import { describe, expect, it } from "vitest";
import { classifyAddress } from "../../src/infra/egress/addresses";

/**
 * Table-driven because the value of this file is coverage of the ranges, not
 * elegance. Every row that is missing here is a range somebody can reach.
 */

const blocked = (address: string) => {
	const verdict = classifyAddress(address);
	expect(verdict.allowed, `${address} should be blocked`).toBe(false);
	return verdict;
};

const allowed = (address: string) => {
	const verdict = classifyAddress(address);
	expect(verdict.allowed, `${address} should be allowed`).toBe(true);
};

describe("classifyAddress · IPv4", () => {
	it("blocks the cloud metadata endpoint by name", () => {
		const verdict = blocked("169.254.169.254");
		// Named explicitly rather than falling through to link-local, so that
		// narrowing the link-local rule later cannot silently uncover it.
		expect(verdict.allowed).toBe(false);
		if (!verdict.allowed) expect(verdict.reason).toContain("metadata");
	});

	it.each([
		["0.0.0.0", "this-network"],
		["10.0.0.1", "private"],
		["10.255.255.255", "private"],
		["100.64.0.1", "shared-cgnat"],
		["127.0.0.1", "loopback"],
		["127.1.2.3", "loopback"],
		["169.254.1.1", "link-local"],
		["172.16.0.1", "private"],
		["172.31.255.255", "private"],
		["192.0.0.1", "ietf-protocol"],
		["192.0.2.5", "test-net-1"],
		["192.88.99.1", "6to4-relay"],
		["192.168.1.1", "private"],
		["198.18.0.1", "benchmarking"],
		["198.51.100.1", "test-net-2"],
		["203.0.113.1", "test-net-3"],
		["224.0.0.1", "multicast"],
		["239.255.255.255", "multicast"],
		["240.0.0.1", "reserved"],
		["255.255.255.255", "reserved"],
	])("blocks %s", (address) => {
		blocked(address);
	});

	it.each([
		"1.1.1.1",
		"8.8.8.8",
		"93.184.216.34",
		"172.15.255.255", // one below the private block
		"172.32.0.0", // one above it
		"100.63.255.255", // one below CGNAT
		"223.255.255.255", // one below multicast
	])("allows %s", (address) => {
		allowed(address);
	});

	it("rejects octal and other permissive spellings rather than parsing them", () => {
		// 0177.0.0.1 is 127.0.0.1 to a resolver that accepts octal. Refusing to
		// parse it is safer than parsing it one way while the OS parses it
		// another.
		blocked("0177.0.0.1");
		blocked("1.1.1.01");
		blocked("2130706433");
	});
});

describe("classifyAddress · IPv6", () => {
	it.each([
		["::1", "loopback"],
		["::", "unspecified"],
		["fe80::1", "link-local"],
		["fc00::1", "unique-local"],
		["fd12:3456::1", "unique-local"],
		["ff02::1", "multicast"],
		["2001:db8::1", "documentation"],
		["64:ff9b::1", "NAT64"],
		["100::1", "discard"],
	])("blocks %s", (address) => {
		blocked(address);
	});

	it("unwraps IPv4-mapped addresses instead of pattern-matching the prefix", () => {
		// The three spellings of loopback that a v6-only prefix check misses.
		blocked("::ffff:127.0.0.1");
		blocked("::ffff:169.254.169.254");
		blocked("::127.0.0.1");
		blocked("2002:7f00:0001::"); // 6to4 wrapping 127.0.0.1
	});

	it("still blocks a mapped address that would otherwise be public, as 6to4", () => {
		// 2002:0808:0808:: wraps 8.8.8.8 — a public address, but reached through
		// a relay we have no reason to use.
		blocked("2002:0808:0808::");
	});

	it("allows ordinary global unicast", () => {
		allowed("2606:4700:4700::1111");
		allowed("2a00:1450:4009:81f::200e");
	});

	it("ignores a zone index when judging scope", () => {
		blocked("fe80::1%eth0");
	});
});

describe("classifyAddress · malformed input", () => {
	it.each([
		"",
		"not-an-address",
		"example.com",
		"999.1.1.1",
		"1.2.3",
		"1.2.3.4.5",
		"::gggg",
		"12345::1",
	])("blocks %s rather than guessing", (address) => {
		blocked(address);
	});
});
