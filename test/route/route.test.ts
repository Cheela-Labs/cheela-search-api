import { describe, expect, it } from "vitest";
import { createClassifier } from "../../src/domain/route/classifier";
import { routeStructurally } from "../../src/domain/route/structural";
import type { TextModel } from "../../src/infra/model/types";

const model = (reply: string): TextModel => ({
	name: "stub",
	async complete() {
		return reply;
	},
});

describe("routeStructurally", () => {
	it.each([
		["nike.com", "https://nike.com/"],
		["NIKE.COM", "https://nike.com/"],
		["docs.example.co.uk", "https://docs.example.co.uk/"],
		["https://example.com/path?a=1", "https://example.com/path?a=1"],
	])("routes %s navigationally", (query, url) => {
		expect(routeStructurally(query)).toEqual({
			intent: "navigational",
			url,
		});
	});

	it.each(["nike jordans", "how do refunds work", "example.com pricing"])(
		"leaves %s to the classifier",
		(query) => {
			// More than one token is a question, not an address, whatever it contains.
			expect(routeStructurally(query)).toEqual({ intent: null });
		},
	);

	it("does not mistake a file extension for a hostname", () => {
		// `node.js` is a hostname by shape and a topic by intent. Routing it
		// navigationally answers a deployment question with a link to a domain
		// that does not exist — and skips retrieval, so there is no recovery.
		for (const query of ["node.js", "vite.config.ts", "readme.md", "main.py"]) {
			expect(routeStructurally(query), query).toEqual({ intent: null });
		}
	});

	it.each(["", "   ", "jordans", "a.b", "not a url", "ftp://x.test/"])(
		"declines %s",
		(query) => {
			expect(routeStructurally(query).intent).toBeNull();
		},
	);
});

describe("createClassifier", () => {
	it("reads the label out of a reply that is not only the label", async () => {
		// Models answer "discovery." and "**discovery**" as readily as "discovery".
		for (const reply of [
			"discovery",
			"discovery.",
			"**discovery**",
			"Intent: discovery",
		]) {
			expect((await createClassifier(model(reply))("q")).intent, reply).toBe(
				"discovery",
			);
		}
	});

	it.each([
		["navigational", "navigational"],
		["informational", "informational"],
		["discovery", "discovery"],
	])("passes through %s", async (reply, expected) => {
		expect((await createClassifier(model(reply))("q")).intent).toBe(expected);
	});

	it("resolves an unrecognised answer downward, not upward", async () => {
		// Ambiguity resolves toward showing. Surfacing an action nobody wanted
		// costs a chip nobody clicks; taking one costs a great deal.
		expect((await createClassifier(model("transactional"))("q")).intent).toBe(
			"informational",
		);
		expect((await createClassifier(model(""))("q")).intent).toBe(
			"informational",
		);
	});

	it("never returns `action`, even when the model says so", async () => {
		// There is no invoker yet. A route to a capability that cannot be called
		// is a route to a dead end.
		expect((await createClassifier(model("action"))("q")).intent).toBe(
			"informational",
		);
	});

	it("treats a model failure as informational rather than failing the query", async () => {
		const broken: TextModel = {
			name: "broken",
			async complete() {
				throw new Error("upstream down");
			},
		};
		expect((await createClassifier(broken)("q")).intent).toBe("informational");
	});
});

/**
 * The rewrite is what makes the discovery label do anything. Labelling "nike
 * jordans" as discovery and then searching "nike jordans" retrieved Wikipedia
 * and a sneaker blog — the label was right and it changed nothing.
 */
describe("classifier · the retrieval rewrite", () => {
	const model = (reply: string): TextModel => ({
		name: "stub",
		async complete() {
			return reply;
		},
	});

	const route = (reply: string) => createClassifier(model(reply))("q");

	it("takes the rewritten query for discovery", async () => {
		expect(
			await route("discovery | buy nike jordan sneakers online store"),
		).toEqual({
			intent: "discovery",
			retrievalQuery: "buy nike jordan sneakers online store",
			freshness: "normal",
		});
	});

	it("collapses a multi-line answer to one query", async () => {
		expect(
			(await route("discovery |\n  buy jordans\n  online")).retrievalQuery,
		).toBe("buy jordans online");
	});

	it("bounds the rewrite, so the field cannot be used as a channel", async () => {
		const long = (await route(`discovery | ${"buy shoes ".repeat(60)}`))
			.retrievalQuery;
		expect(long).not.toBeNull();
		expect((long as string).length).toBeLessThanOrEqual(120);
	});

	it("carries no rewrite when the model ignored the format", async () => {
		expect(await route("discovery")).toEqual({
			intent: "discovery",
			retrievalQuery: null,
			freshness: "normal",
		});
		expect((await route("discovery |   ")).retrievalQuery).toBeNull();
	});

	it("never carries a rewrite for a non-discovery intent", async () => {
		// The pipeline searches it unconditionally when present, so a rewrite
		// attached to an informational query would silently change what an
		// ordinary question retrieves.
		expect(
			(await route("informational | buy things")).retrievalQuery,
		).toBeNull();
		expect(
			(await route("navigational | buy things")).retrievalQuery,
		).toBeNull();
	});
});

/**
 * Freshness — the one signal that decides whether a seven-day-old cached page
 * is served or re-checked.
 *
 * The parsing matters more than it looks. The prompt asks for three
 * pipe-delimited fields and models reliably produce two of them, sometimes in
 * the other order. Reading by position gives an informational query a retrieval
 * query of `"fresh"` — which the pipeline would then *search for*, and which
 * looks like a bad index rather than a bad parse.
 */
describe("classifier · freshness", () => {
	const model = (reply: string): TextModel => ({
		name: "stub",
		async complete() {
			return reply;
		},
	});

	const route = (reply: string) => createClassifier(model(reply))("q");

	it("is normal when the model says nothing about it", async () => {
		expect((await route("informational")).freshness).toBe("normal");
		expect((await route("discovery | buy shoes")).freshness).toBe("normal");
	});

	it("reads the marker on a query with no rewrite", async () => {
		expect((await route("informational | fresh")).freshness).toBe("high");
	});

	it("does not mistake the marker for a retrieval query", async () => {
		// The failure this guards: `"fresh"` becoming the search string.
		const informational = await route("informational | fresh");
		expect(informational.retrievalQuery).toBeNull();

		const discovery = await route("discovery | fresh");
		expect(discovery.freshness).toBe("high");
		expect(discovery.retrievalQuery).toBeNull();
	});

	it("takes both a rewrite and the marker, in either order", async () => {
		const trailing = await route("discovery | book flights to goa | fresh");
		expect(trailing.freshness).toBe("high");
		expect(trailing.retrievalQuery).toBe("book flights to goa");

		// Models do reverse these. The rewrite must survive it rather than
		// becoming "fresh book flights to goa".
		const leading = await route("discovery | fresh | book flights to goa");
		expect(leading.freshness).toBe("high");
		expect(leading.retrievalQuery).toBe("book flights to goa");
	});

	it("resolves downward when the model fails", async () => {
		const broken: TextModel = {
			name: "broken",
			async complete() {
				throw new Error("upstream down");
			},
		};
		// Ambiguity resolves to the cheap wrong answer, not the expensive one: a
		// stale page beats re-fetching every page on every query.
		expect((await createClassifier(broken)("q")).freshness).toBe("normal");
	});

	it("does not read the marker from the intent field itself", async () => {
		// "fresh" appearing where the label goes is not a freshness verdict — it
		// is a model that ignored the format, and the intent parse already
		// handles that by falling back to informational.
		expect((await route("fresh")).freshness).toBe("normal");
	});
});
