import { describe, expect, it } from "vitest";
import type { Classification } from "../../src/contracts/intent.js";
import type { TextModel } from "../../src/infra/model/index.js";
import {
	createEvolution,
	worthExpanding,
} from "../../src/services/evolution/index.js";
import { reciprocalRankFusion } from "../../src/services/evolution/rrf.js";

const identity = (item: string) => item;

describe("reciprocal rank fusion", () => {
	it("matches the formula, computed by hand", () => {
		// k = 60, so a rank-1 document contributes 1/61 and rank-2 contributes
		// 1/62. These numbers are worked out longhand rather than snapshotted,
		// because a snapshot of a wrong implementation is a wrong test.
		const fused = reciprocalRankFusion(
			[{ items: ["a", "b", "c"] }, { items: ["a", "c", "d"] }],
			identity,
		);

		const score = (id: string) =>
			fused.find((entry) => entry.item === id)?.score ?? 0;

		expect(score("a")).toBeCloseTo(1 / 61 + 1 / 61, 10);
		expect(score("b")).toBeCloseTo(1 / 62, 10);
		expect(score("c")).toBeCloseTo(1 / 63 + 1 / 62, 10);
		expect(score("d")).toBeCloseTo(1 / 63, 10);
	});

	it("puts agreement ahead of depth in any one list", () => {
		// `c` is ranked below `b` in the only list that contains `b`, but two
		// lists contain `c`. Preferring `c` is the entire reason for running
		// several hypotheses: agreement across interpretations is the evidence.
		const fused = reciprocalRankFusion(
			[{ items: ["a", "b", "c"] }, { items: ["a", "c", "d"] }],
			identity,
		);

		expect(fused.map((entry) => entry.item)).toEqual(["a", "c", "b", "d"]);
	});

	it("counts how many lists agreed, and remembers which", () => {
		const fused = reciprocalRankFusion(
			[
				{ items: ["a", "b"], label: "original" },
				{ items: ["b"], label: "expansion" },
			],
			identity,
		);

		const b = fused.find((entry) => entry.item === "b");
		expect(b?.agreement).toBe(2);
		expect(b?.labels).toEqual(["original", "expansion"]);
	});

	it("weights a list down without removing it", () => {
		const full = reciprocalRankFusion(
			[{ items: ["x"] }, { items: ["y"] }],
			identity,
		);
		expect(full[0].score).toBeCloseTo(full[1].score, 10);

		const weighted = reciprocalRankFusion(
			[
				{ items: ["x"], weight: 1 },
				{ items: ["y"], weight: 0.5 },
			],
			identity,
		);
		expect(weighted[0].item).toBe("x");
		expect(weighted[1].score).toBeCloseTo(0.5 / 61, 10);
	});

	it("keeps the first payload seen for a repeated key", () => {
		type Doc = { url: string; title: string };
		const fused = reciprocalRankFusion<Doc>(
			[
				{ items: [{ url: "u", title: "first" }] },
				{ items: [{ url: "u", title: "second" }] },
			],
			(doc) => doc.url,
		);

		expect(fused).toHaveLength(1);
		expect(fused[0].item.title).toBe("first");
		expect(fused[0].agreement).toBe(2);
	});

	it("survives empty and single lists", () => {
		expect(reciprocalRankFusion<string>([], identity)).toEqual([]);
		expect(reciprocalRankFusion([{ items: [] }], identity)).toEqual([]);
		expect(
			reciprocalRankFusion([{ items: ["only"] }], identity).map((e) => e.item),
		).toEqual(["only"]);
	});
});

describe("worthExpanding", () => {
	it("expands the short, ambiguous queries expansion is for", () => {
		expect(worthExpanding("PS5", "shopping")).toBe(true);
		expect(worthExpanding("Australian wildfire", "event")).toBe(true);
	});

	it("leaves a specific question alone", () => {
		// It has already said what it means, and expansion would only cost
		// latency inside the budget.
		expect(
			worthExpanding(
				"how many people died in the 2019 australian bushfire season",
				"event",
			),
		).toBe(false);
	});

	it("never expands a navigation query", () => {
		// The user named a destination. There is no second interpretation.
		expect(worthExpanding("github.com", "navigation")).toBe(false);
	});
});

const classification = (
	overrides: Partial<Classification> = {},
): Classification => ({
	intent: "shopping",
	confidence: 0.9,
	entities: [],
	...overrides,
});

const modelReturning = (text: string): TextModel => ({
	complete: async () => text,
});

describe("the evolution engine", () => {
	it("produces the specification's own PS5 hypotheses", async () => {
		const evolution = createEvolution({
			model: modelReturning(
				[
					"PlayStation 5 reviews",
					"PlayStation 5 price",
					"Buy PlayStation 5",
					"Sony PlayStation 5",
				].join("\n"),
			),
		});

		const hypotheses = await evolution.expand("PS5", classification());
		const queries = hypotheses.map((entry) => entry.query);

		// The original is always first and always present.
		expect(queries[0]).toBe("PS5");
		expect(queries).toContain("PlayStation 5 price");
		expect(hypotheses[0].weight).toBe(1);
		// Expansions are trusted less than what the user typed.
		expect(hypotheses.slice(1).every((entry) => entry.weight < 1)).toBe(true);
	});

	it("prefers a remembered expansion over an invented one", async () => {
		const evolution = createEvolution({
			model: modelReturning("Black Summer fires"),
			remembered: async () => ["2019-20 Australian bushfire season"],
		});

		const hypotheses = await evolution.expand(
			"Australian wildfire",
			classification({ intent: "event" }),
		);

		const remembered = hypotheses.find((entry) => entry.source === "memory");
		const invented = hypotheses.find((entry) => entry.source === "model");
		expect(remembered?.query).toBe("2019-20 Australian bushfire season");
		// An expansion somebody clicked outranks one a model just produced.
		expect(remembered?.weight).toBeGreaterThan(invented?.weight ?? 1);
	});

	it("strips list markers and quotes the model adds anyway", async () => {
		const evolution = createEvolution({
			model: modelReturning('1. "PlayStation 5 price"\n- Buy PlayStation 5'),
		});

		const queries = (await evolution.expand("PS5", classification())).map(
			(entry) => entry.query,
		);
		expect(queries).toContain("PlayStation 5 price");
		expect(queries).toContain("Buy PlayStation 5");
	});

	it("drops duplicates, including of the original", async () => {
		const evolution = createEvolution({
			model: modelReturning("PS5\nps5\nPlayStation 5"),
		});

		const queries = (await evolution.expand("PS5", classification())).map(
			(entry) => entry.query,
		);
		expect(queries).toEqual(["PS5", "PlayStation 5"]);
	});

	it("still searches the original when the model fails", async () => {
		const evolution = createEvolution({
			model: {
				complete: async () => {
					throw new Error("model is down");
				},
			},
		});

		const hypotheses = await evolution.expand("PS5", classification());
		// Degraded to one hypothesis, not to zero. Expansion is an optimisation
		// and its failure must cost recall rather than the answer.
		expect(hypotheses.map((entry) => entry.query)).toEqual(["PS5"]);
	});

	it("survives a graph outage the same way", async () => {
		const evolution = createEvolution({
			model: modelReturning("PlayStation 5 price"),
			aliases: async () => {
				throw new Error("graph is down");
			},
		});

		const queries = (await evolution.expand("PS5", classification())).map(
			(entry) => entry.query,
		);
		expect(queries).toContain("PlayStation 5 price");
	});
});
