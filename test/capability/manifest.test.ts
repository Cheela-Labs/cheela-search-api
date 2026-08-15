import { describe, expect, it } from "vitest";

import {
	effectsFor,
	probeManifest,
	readManifest,
} from "../../src/domain/capability/manifest";
import type { EgressClient } from "../../src/infra/egress/client";

/**
 * Reading a manifest written by a stranger — Phase 1 of PLAN.md.
 *
 * The rules under test are mostly about *not* being strict, because the strict
 * version silently loses information that costs a full re-crawl to recover.
 */

function manifest(capabilities: unknown[]): string {
	return JSON.stringify({
		specVersion: "0.3.0",
		id: "com.example.thing",
		name: "Thing",
		provider: { name: "Thing" },
		capabilities,
	});
}

const CAPABILITY = {
	name: "com.example.thing.get-item",
	invocationName: "get-item",
	version: "1.0.0",
	endpoint: {
		transport: "https",
		address: "https://example.com/api",
		auth: "none",
	},
};

/**
 * The tier is derived from structure and never from prose.
 *
 * **PLAN.md's invariant: manifest text can only lower a capability's privilege,
 * never raise it.** These cases are the correction from a real run — the first
 * version matched the *nouns* `order` and `payment` and labelled two reads as
 * financial.
 */
describe("effects derivation", () => {
	it("reads the verb, not the surrounding nouns", () => {
		// Both of these came back `financial` before the fix. A warning about a
		// payment on a capability that only lists them is a false alarm that
		// teaches people to ignore the true ones.
		expect(effectsFor({ name: "orders-get-order" })).toBe("read");
		expect(effectsFor({ name: "store-list-payment-methods" })).toBe("read");
	});

	it("still catches the verbs that matter", () => {
		expect(effectsFor({ name: "checkout-pay-order" })).toBe("financial");
		expect(effectsFor({ name: "cart-remove-item" })).toBe("write-irreversible");
		expect(effectsFor({ name: "calendar-delete-event" })).toBe(
			"write-irreversible",
		);
		expect(effectsFor({ name: "calendar-create-event" })).toBe(
			"write-reversible",
		);
	});

	/** An honest "we cannot tell" beats a confident wrong tier in either direction. */
	it("answers unknown when the name says nothing", () => {
		expect(effectsFor({ name: "com.example.thing.frobnicate" })).toBe(
			"unknown",
		);
	});

	/**
	 * The invariant, stated as a test.
	 *
	 * The description is never an input, so a manifest cannot talk its way into
	 * a gentler tier.
	 */
	it("cannot be talked down by the manifest's own prose", () => {
		expect(
			effectsFor({ name: "deleteAllRecords", invocationName: "delete-all" }),
		).toBe("write-irreversible");
	});
});

/** A client that returns one canned response, so no server is involved. */
function stubClient(
	response: Partial<{
		status: number;
		body: string;
		headers: Record<string, string>;
	}>,
): EgressClient {
	return {
		async fetch(url: string) {
			return {
				url,
				status: response.status ?? 200,
				headers: response.headers ?? {},
				body: Buffer.from(response.body ?? ""),
			};
		},
	} as EgressClient;
}

describe("readManifest", () => {
	it("reads a valid manifest", () => {
		const probe = readManifest(manifest([CAPABILITY]), "https://x/m.json");

		expect(probe.state).toBe("valid");
		if (probe.state !== "valid") return;
		expect(probe.capabilities).toHaveLength(1);
		expect(probe.capabilities[0].invocationName).toBe("get-item");
		expect(probe.capabilities[0].effects).toBe("read");
		expect(probe.capabilities[0].invocableByUs).toBe(true);
	});

	/**
	 * "We cannot call it, but the site still does this and the user should still
	 * be told. Not-invocable-by-us is a property of the result, not a reason to
	 * hide it."
	 */
	it("keeps a capability whose transport we do not speak", () => {
		const probe = readManifest(
			manifest([
				{
					...CAPABILITY,
					endpoint: { ...CAPABILITY.endpoint, transport: "carrier-pigeon" },
				},
			]),
			"https://x/m.json",
		);

		expect(probe.state).toBe("valid");
		if (probe.state !== "valid") return;
		expect(probe.capabilities).toHaveLength(1);
		expect(probe.capabilities[0].invocableByUs).toBe(false);
	});

	/**
	 * A `/.well-known/` path answering 200 with HTML is a catch-all route rather
	 * than a manifest, and every SPA does it.
	 */
	it("does not mistake a catch-all HTML route for a manifest", () => {
		const probe = readManifest(
			"<!doctype html><html></html>",
			"https://x/m.json",
		);
		expect(probe.state).toBe("unreadable");
		if (probe.state !== "unreadable") return;
		expect(probe.detail).toBe("not JSON");
	});

	/** Guessing at a spec we have not seen misinterprets fields rather than skipping them. */
	it("stops at a major spec version ahead of ours", () => {
		const probe = readManifest(
			JSON.stringify({
				specVersion: "99.0.0",
				id: "x",
				name: "x",
				provider: { name: "x" },
				capabilities: [CAPABILITY],
			}),
			"https://x/m.json",
		);
		expect(probe.state).toBe("invalid");
	});

	/**
	 * An invalid manifest is kept rather than discarded — it is evidence about
	 * the spec in the wild, and the row is what makes that measurable.
	 */
	it("keeps the raw body of a manifest that failed validation", () => {
		const probe = readManifest(
			JSON.stringify({ nonsense: true }),
			"https://x/m.json",
		);

		expect(probe.state).toBe("invalid");
		if (probe.state !== "invalid") return;
		expect(probe.raw).toEqual({ nonsense: true });
		expect(probe.hash).toHaveLength(64);
	});
});

describe("probeManifest", () => {
	/** 404 is the normal outcome for most of the web and is never an alert. */
	it("treats a missing manifest as absent, not as an error", async () => {
		const probe = await probeManifest(
			"example.com",
			stubClient({ status: 404 }),
		);
		expect(probe.state).toBe("absent");
	});

	it("treats an unchanged manifest as absent so the caller keeps what it has", async () => {
		const probe = await probeManifest(
			"example.com",
			stubClient({ status: 304 }),
			'"v1"',
		);
		expect(probe.state).toBe("absent");
	});

	it("reports a server error as unreadable rather than absent", async () => {
		const probe = await probeManifest(
			"example.com",
			stubClient({ status: 503 }),
		);
		expect(probe.state).toBe("unreadable");
	});

	/** Fetched over https, because a manifest names endpoints and their auth. */
	it("asks for the well-known path over https", async () => {
		let seen = "";
		const client = {
			async fetch(url: string) {
				seen = url;
				return { url, status: 404, headers: {}, body: Buffer.from("") };
			},
		} as EgressClient;

		await probeManifest("example.com", client);
		expect(seen).toBe("https://example.com/.well-known/agent-discovery.json");
	});
});
