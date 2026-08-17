import { describe, expect, it } from "vitest";
import {
	classifyAddress,
	parseIPv4,
} from "../../src/infra/egress/addresses.js";

const blocked = (address: string) => {
	const verdict = classifyAddress(address);
	expect(verdict.allowed, `${address} should be blocked`).toBe(false);
	return verdict.allowed ? "" : verdict.reason;
};

const allowed = (address: string) => {
	const verdict = classifyAddress(address);
	expect(verdict.allowed, `${address} should be allowed`).toBe(true);
};

describe("parseIPv4", () => {
	it("reads four decimal octets", () => {
		expect(parseIPv4("0.0.0.0")).toBe(0);
		expect(parseIPv4("127.0.0.1")).toBe(0x7f_00_00_01);
		expect(parseIPv4("255.255.255.255")).toBe(0xff_ff_ff_ff);
	});

	it("rejects octal, which is the whole point", () => {
		// inet_aton reads this as 127.0.0.1. A checker that disagrees with the
		// connector about which host this is, is the vulnerability itself.
		expect(parseIPv4("0177.0.0.1")).toBeNull();
		expect(parseIPv4("010.0.0.1")).toBeNull();
	});

	it("rejects short forms, hex, and out-of-range octets", () => {
		expect(parseIPv4("127.1")).toBeNull();
		expect(parseIPv4("0x7f.0.0.1")).toBeNull();
		expect(parseIPv4("256.0.0.1")).toBeNull();
		expect(parseIPv4("1.2.3.4.5")).toBeNull();
		expect(parseIPv4("1.2.3.")).toBeNull();
	});
});

describe("classifyAddress, IPv4", () => {
	it("names the metadata server specifically", () => {
		// Not merely "blocked" — this one must be identifiable in a log,
		// because it is the difference between a broken link and an incident.
		expect(blocked("169.254.169.254")).toBe("gcp-metadata");
	});

	it("blocks every non-public range", () => {
		expect(blocked("0.0.0.1")).toBe("this-network");
		expect(blocked("10.1.2.3")).toBe("private");
		expect(blocked("100.64.0.1")).toBe("shared-cgnat");
		expect(blocked("127.0.0.1")).toBe("loopback");
		expect(blocked("169.254.1.1")).toBe("link-local");
		expect(blocked("172.16.0.1")).toBe("private");
		expect(blocked("172.31.255.255")).toBe("private");
		expect(blocked("192.0.0.1")).toBe("ietf-protocol");
		expect(blocked("192.0.2.1")).toBe("test-net-1");
		expect(blocked("192.88.99.1")).toBe("6to4-relay");
		expect(blocked("192.168.1.1")).toBe("private");
		expect(blocked("198.18.0.1")).toBe("benchmarking");
		expect(blocked("198.51.100.1")).toBe("test-net-2");
		expect(blocked("203.0.113.1")).toBe("test-net-3");
		expect(blocked("224.0.0.1")).toBe("multicast");
		expect(blocked("240.0.0.1")).toBe("reserved");
		expect(blocked("255.255.255.255")).toBe("broadcast");
	});

	it("allows public unicast, including the edges of blocked ranges", () => {
		allowed("1.1.1.1");
		allowed("8.8.8.8");
		// One below 10.0.0.0/8 and one above 172.16/12.
		allowed("9.255.255.255");
		allowed("172.32.0.1");
		allowed("11.0.0.1");
		allowed("223.255.255.255");
	});
});

describe("classifyAddress, IPv6", () => {
	it("unwraps IPv4-mapped addresses rather than treating them as v6", () => {
		expect(blocked("::ffff:127.0.0.1")).toBe("loopback");
		expect(blocked("::ffff:169.254.169.254")).toBe("gcp-metadata");
		expect(blocked("::ffff:10.0.0.1")).toBe("private");
		allowed("::ffff:8.8.8.8");
	});

	it("unwraps the deprecated compatible form", () => {
		expect(blocked("::127.0.0.1")).toBe("loopback");
	});

	it("looks inside 6to4 and NAT64 for the address they tunnel to", () => {
		expect(blocked("2002:7f00:0001::")).toBe("6to4:loopback");
		expect(blocked("2002:a9fe:a9fe::")).toBe("6to4:gcp-metadata");
		expect(blocked("64:ff9b::127.0.0.1")).toBe("nat64:loopback");
	});

	it("blocks the v6 local ranges", () => {
		expect(blocked("::1")).toBe("loopback");
		expect(blocked("::")).toBe("unspecified");
		expect(blocked("fc00::1")).toBe("unique-local");
		expect(blocked("fd12:3456::1")).toBe("unique-local");
		expect(blocked("fe80::1")).toBe("link-local");
		expect(blocked("fe80::1%eth0")).toBe("link-local");
		expect(blocked("ff02::1")).toBe("multicast");
	});

	it("allows public v6", () => {
		allowed("2001:4860:4860::8888");
		allowed("2606:4700:4700::1111");
	});
});

describe("classifyAddress, anything else", () => {
	it("refuses what it cannot parse, rather than assuming", () => {
		// "I could not tell what this is" must never mean "so I connected".
		expect(blocked("")).toBe("unparseable");
		expect(blocked("not-an-address")).toBe("unparseable");
		expect(blocked("999.999.999.999")).toBe("unparseable");
		expect(blocked("12345")).toBe("unparseable");
	});
});
