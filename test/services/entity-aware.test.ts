import { describe, expect, it } from "vitest";
import { classifyStructurally } from "../../src/services/intent/index.js";
import type { EntitySignals } from "../../src/services/ranking/entity-aware.js";
import {
	applyEntitySignals,
	depthOf,
	scoreWithEntitySignals,
} from "../../src/services/ranking/entity-aware.js";
import type { RetrievedDocument } from "../../src/services/retriever/index.js";

const doc = (
	url: string,
	origin: "index" | "external" = "index",
): RetrievedDocument => {
	const parsed = new URL(url);
	return {
		docId: url,
		url,
		domain: parsed.hostname,
		path: parsed.pathname,
		title: url,
		snippet: "",
		body: "",
		chunks: [],
		authority: 0.5,
		publishedAt: 0,
		origin,
		fusedScore: 0.02,
		agreement: 1,
		features: origin === "index" ? { lexical: 0.5 } : {},
	};
};

const NAV: EntitySignals = {
	intent: "navigation",
	entity: "Redis",
	officialDomain: "redis.io",
	confidence: 1,
};

const order = (documents: RetrievedDocument[], signals: EntitySignals = NAV) =>
	applyEntitySignals(documents, signals).map((entry) => entry.url);

describe("depthOf", () => {
	it("counts path segments, ignoring trailing slashes", () => {
		expect(depthOf("/")).toBe(0);
		expect(depthOf("/docs")).toBe(1);
		expect(depthOf("/docs/")).toBe(1);
		expect(depthOf("/docs/latest")).toBe(2);
	});
});

describe("the official-domain boost", () => {
	it("puts the official homepage first even from the bottom of the list", () => {
		// The case this whole layer exists for. Production returned five GitHub
		// pages for "redis" and no redis.io at all; once retrieval finds it, it
		// must not matter that it was ranked last.
		const documents = [
			doc("https://github.com/topics/vector-search"),
			doc("https://github.com/topics/valkey"),
			doc("https://en.wikipedia.org/wiki/Redis"),
			doc("https://redis.io/"),
		];
		expect(order(documents)[0]).toBe("https://redis.io/");
	});

	it("prefers the homepage over deeper pages on the same official domain", () => {
		const documents = [
			doc("https://redis.io/docs/latest/commands"),
			doc("https://redis.io/blog/post"),
			doc("https://redis.io/"),
			doc("https://redis.io/docs"),
		];
		expect(order(documents)).toEqual([
			"https://redis.io/",
			"https://redis.io/docs",
			"https://redis.io/blog/post",
			"https://redis.io/docs/latest/commands",
		]);
	});

	it("treats www and subdomains as the same owner", () => {
		for (const url of ["https://www.redis.io/", "https://docs.redis.io/"]) {
			expect(order([doc("https://github.com/redis"), doc(url)])[0]).toBe(url);
		}
	});

	it("does not treat a lookalike domain as official", () => {
		const documents = [doc("https://redis.io/"), doc("https://notredis.io/")];
		expect(order(documents)[0]).toBe("https://redis.io/");
		const scored = scoreWithEntitySignals(documents, NAV);
		expect(
			scored.find((s) => s.document.domain === "notredis.io")?.official,
		).toBe(false);
	});

	it("ranks an official external result above a non-official index one", () => {
		// Index results are concatenated ahead of external ones by the retriever,
		// which is right at equal evidence and wrong here: we may not have crawled
		// redis.io yet, and an upstream that found it is still the right answer.
		const documents = [
			doc("https://github.com/topics/redis", "index"),
			doc("https://redis.io/", "external"),
		];
		expect(order(documents)[0]).toBe("https://redis.io/");
	});
});

describe("soft penalties", () => {
	it("demotes generic knowledge domains on a navigational query", () => {
		const documents = [
			doc("https://en.wikipedia.org/wiki/Redis"),
			doc("https://example.com/redis-notes"),
		];
		expect(order(documents)[0]).toBe("https://example.com/redis-notes");
	});

	it("leaves informational queries completely untouched", () => {
		// `redis wiki` must still return Wikipedia. The penalty leaking into
		// informational intent would be a worse regression than the bug this
		// layer fixes.
		const documents = [
			doc("https://en.wikipedia.org/wiki/Redis"),
			doc("https://redis.io/"),
			doc("https://github.com/redis/redis"),
		];
		const informational: EntitySignals = {
			intent: "information",
			confidence: 1,
			entity: "Redis",
			officialDomain: "redis.io",
		};
		expect(order(documents, informational)).toEqual(
			documents.map((entry) => entry.url),
		);
	});

	it("never penalises a domain for being its own official answer", () => {
		// Query "github": github.com is both a penalised domain and the correct
		// destination. It must win.
		const documents = [
			doc("https://en.wikipedia.org/wiki/GitHub"),
			doc("https://github.com/"),
		];
		expect(
			order(documents, {
				intent: "navigation",
				entity: "GitHub",
				officialDomain: "github.com",
				confidence: 1,
			})[0],
		).toBe("https://github.com/");
	});
});

describe("gating", () => {
	it("is a no-op below the confidence threshold", () => {
		const documents = [
			doc("https://github.com/topics/redis"),
			doc("https://redis.io/"),
		];
		expect(order(documents, { ...NAV, confidence: 0.3 })).toEqual(
			documents.map((entry) => entry.url),
		);
	});

	it("does nothing at all when no official domain is known", () => {
		// This used to demote encyclopaedic domains on any confident navigational
		// intent, registry hit or not. Production showed why that is wrong:
		// `redis wiki` is classified navigation by the model and resolves to no
		// entity, and the penalty moved en.wikipedia.org from first to fourth —
		// for a query whose author had written "wiki" in it. With no official
		// site to protect, the penalty has no counterparty and is pure harm.
		const documents = [
			doc("https://en.wikipedia.org/wiki/Redis"),
			doc("https://github.com/topics/whatever"),
			doc("https://example.com/x"),
		];
		expect(order(documents, { intent: "navigation", confidence: 1 })).toEqual(
			documents.map((entry) => entry.url),
		);
	});

	it("boosts nothing when no official domain is known", () => {
		const scored = scoreWithEntitySignals([doc("https://example.com/x")], {
			intent: "navigation",
			confidence: 1,
		});
		expect(scored[0].official).toBe(false);
	});

	it("preserves retrieval order for everything it does not distinguish", () => {
		// The property that makes this safe to run on every request.
		const documents = [
			doc("https://a.example/1"),
			doc("https://b.example/2"),
			doc("https://c.example/3"),
		];
		expect(order(documents)).toEqual(documents.map((entry) => entry.url));
	});

	it("handles an empty result set", () => {
		expect(applyEntitySignals([], NAV)).toEqual([]);
	});
});

describe("navigational intent detection", () => {
	const registry = {
		lookup: (surface: string) =>
			surface === "redis"
				? { name: "Redis", officialDomain: "redis.io" }
				: surface === "hugging face"
					? { name: "Hugging Face", officialDomain: "huggingface.co" }
					: null,
	};

	const nav = (query: string) => classifyStructurally(query, registry);

	it("recognises a bare entity name", () => {
		expect(nav("redis")).toMatchObject({
			intent: "navigation",
			entity: "Redis",
			officialDomain: "redis.io",
		});
	});

	it("recognises a name followed by a destination word", () => {
		// The whitespace bail meant `vercel login` could never reach this pass at
		// all, which is why entity-name navigation was left to the model and came
		// back inconsistent.
		expect(nav("redis login")).toMatchObject({ officialDomain: "redis.io" });
	});

	it("prefers the longest matching name", () => {
		// "hugging face" is one entity. Matching word by word would resolve it to
		// nothing, or worse, to something called "face".
		expect(nav("hugging face")).toMatchObject({
			officialDomain: "huggingface.co",
		});
	});

	it("refuses modifiers that ask about the name rather than for it", () => {
		for (const query of ["redis tutorial", "redis wiki", "redis vs valkey"]) {
			expect(nav(query), query).toBeNull();
		}
	});

	it("refuses questions", () => {
		expect(nav("what is redis")).toBeNull();
		expect(nav("how redis works")).toBeNull();
	});

	it("refuses anything longer than three words", () => {
		expect(nav("redis cluster setup guide")).toBeNull();
	});

	it("refuses a name it does not know", () => {
		expect(nav("некоторыйбренд")).toBeNull();
		expect(nav("zzzz")).toBeNull();
	});

	it("still recognises a bare hostname, and treats it as its own official domain", () => {
		expect(classifyStructurally("redis.io")).toMatchObject({
			intent: "navigation",
			officialDomain: "redis.io",
		});
		// A file name is not a hostname.
		expect(classifyStructurally("index.ts")).toBeNull();
	});

	it("does nothing without a registry, so the old behaviour is unchanged", () => {
		expect(classifyStructurally("redis")).toBeNull();
	});
});
