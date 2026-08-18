import { describe, expect, it } from "vitest";
import {
	isFollowUp,
	overlap,
	signalsFor,
	type Turn,
	terms,
} from "../../src/services/context/index.js";
import { priority, WEIGHTS } from "../../src/services/crawler/index.js";
import {
	MAX_SINGLE_OBSERVATION,
	parseExtraction,
} from "../../src/services/knowledge-graph/extract.js";
import {
	accumulate,
	entityId,
} from "../../src/services/knowledge-graph/index.js";
import {
	selectCapabilities,
	selectPassages,
} from "../../src/services/ranking/index.js";
import type { RetrievedDocument } from "../../src/services/retriever/index.js";
import { indexConfidence } from "../../src/services/retriever/index.js";
import type { IndexedCapability } from "../../src/services/retriever/vespa-stage.js";

/* -------------------------------------------------------------------------- */
/* Context Engine                                                             */
/* -------------------------------------------------------------------------- */

const turn = (overrides: Partial<Turn> = {}): Turn => ({
	query: "Australian wildfire",
	resolved: "Australian wildfire",
	intent: "event",
	entities: ["Australia"],
	at: Date.now(),
	...overrides,
});

const WINDOW = 1_800_000;

describe("follow-up detection", () => {
	it("reads the specification's own example as a follow-up", () => {
		// "Australian wildfire" then "How many died?" — the query that motivates
		// the whole Context Engine, because it retrieves nothing on its own.
		const signals = signalsFor("How many died?", turn(), Date.now(), WINDOW);
		expect(signals.elliptical).toBe(true);
		expect(signals.short).toBe(true);
		expect(isFollowUp(signals)).toBe(true);
	});

	it("reads a pronoun in a short query as a follow-up", () => {
		const signals = signalsFor("who owns it", turn(), Date.now(), WINDOW);
		expect(signals.pronoun).toBe(true);
		expect(isFollowUp(signals)).toBe(true);
	});

	it("does not treat an unrelated new question as a follow-up", () => {
		// The expensive mistake. Treating a new question as a continuation
		// corrupts it with the previous topic and answers confidently about the
		// wrong thing; missing a follow-up only answers shallowly.
		const signals = signalsFor(
			"best espresso machine under 500",
			turn(),
			Date.now(),
			WINDOW,
		);
		expect(isFollowUp(signals)).toBe(false);
	});

	it("never fires on topical similarity alone", () => {
		// Two independent queries about one subject look similar and are not a
		// conversation. Something referential has to be present.
		const signals = signalsFor(
			"australian wildfire damage statistics",
			turn(),
			Date.now(),
			WINDOW,
		);
		expect(signals.similarity).toBeGreaterThan(0);
		expect(signals.pronoun).toBe(false);
		expect(signals.elliptical).toBe(false);
		expect(isFollowUp(signals)).toBe(false);
	});

	it("never fires outside the session window", () => {
		// An expired session is not a conversation. Resuming one from yesterday
		// would silently rewrite an unrelated query against it.
		const stale = turn({ at: Date.now() - WINDOW - 1000 });
		const signals = signalsFor("How many died?", stale, Date.now(), WINDOW);
		expect(signals.recent).toBe(false);
		expect(isFollowUp(signals)).toBe(false);
	});

	it("counts a named entity carried over from the previous turn", () => {
		const signals = signalsFor(
			"australia fire deaths",
			turn(),
			Date.now(),
			WINDOW,
		);
		expect(signals.sharedEntities).toBe(1);
	});

	it("matches entities on word boundaries, not as substrings", () => {
		// The first version used `includes`, which found "Australia" inside
		// "australian" — and by the same rule finds "Apple" inside "applesauce".
		// A spurious shared entity promotes an unrelated question to a follow-up,
		// which is the expensive direction to be wrong in.
		expect(
			signalsFor(
				"applesauce recipes",
				turn({ entities: ["Apple"] }),
				Date.now(),
				WINDOW,
			).sharedEntities,
		).toBe(0);
		expect(
			signalsFor(
				"apple earnings",
				turn({ entities: ["Apple"] }),
				Date.now(),
				WINDOW,
			).sharedEntities,
		).toBe(1);
	});

	it("does not choke on an entity containing regex metacharacters", () => {
		// Entity names come from a model reading the open web. "C++" and "$GME"
		// are real entity names and both are invalid regexes unescaped.
		expect(() =>
			signalsFor(
				"c++ tutorials",
				turn({ entities: ["C++", "$GME", "a(b"] }),
				Date.now(),
				WINDOW,
			),
		).not.toThrow();
	});
});

describe("term overlap", () => {
	it("is zero for disjoint text and 1 for identical", () => {
		expect(overlap(terms("cats and dogs"), terms("quantum mechanics"))).toBe(0);
		expect(overlap(terms("cats and dogs"), terms("cats and dogs"))).toBe(1);
	});

	it("ignores stop words, so two questions are not similar for saying 'the'", () => {
		expect(terms("what is the best of the options").has("the")).toBe(false);
		expect(overlap(terms("what is the"), terms("how are the"))).toBe(0);
	});
});

/*
   The effects taxonomy and callability rules moved to apps/search-console with
   the code that derives them — see its test/capabilities.test.ts. They are not
   the read plane's concern any more: it reads a verdict, it does not make one.
*/

/* -------------------------------------------------------------------------- */
/* Knowledge graph                                                            */
/* -------------------------------------------------------------------------- */

describe("entityId", () => {
	it("gives one id to the same entity written differently", () => {
		expect(entityId("Larry Page", "Person")).toBe(
			entityId("larry  page", "Person"),
		);
		expect(entityId("PlayStation 5", "Product")).toBe(
			entityId("playstation-5", "Product"),
		);
	});

	it("separates entities of different types with the same name", () => {
		// "Apple" the company and "Apple" the product are different nodes.
		expect(entityId("Apple", "Organization")).not.toBe(
			entityId("Apple", "Product"),
		);
	});
});

describe("accumulate", () => {
	it("raises confidence toward 1 without ever reaching it", () => {
		let value = 0;
		for (let i = 0; i < 50; i += 1) value = accumulate(value, 0.6);
		expect(value).toBeLessThanOrEqual(1);
		expect(value).toBeGreaterThan(0.9);
	});

	it("makes a second observation worth less than the first", () => {
		// Evidence, not voting: the tenth document saying something adds less than
		// the second did.
		const first = accumulate(0, 0.6);
		const second = accumulate(first, 0.6);
		expect(second - first).toBeLessThan(first);
	});
});

describe("parseExtraction", () => {
	it("reads entities and edges from the two sections", () => {
		const result = parseExtraction(`ENTITIES
Larry Page | Person | 0.9
Google | Organization | 0.95

EDGES
Larry Page | founded | Google | 0.9`);

		expect(result.entities.map((entity) => entity.name)).toEqual([
			"Larry Page",
			"Google",
		]);
		expect(result.edges).toHaveLength(1);
		expect(result.edges[0].relation).toBe("founded");
	});

	it("caps what one document may claim", () => {
		// A model's stated confidence is not evidence. Agreement across documents
		// is, and that accumulates in graph.edges rather than here.
		const result = parseExtraction(`ENTITIES
Google | Organization | 1.0`);
		expect(result.entities[0].confidence).toBe(MAX_SINGLE_OBSERVATION);
	});

	it("drops types and relations outside the taxonomy", () => {
		const result = parseExtraction(`ENTITIES
Something | Vegetable | 0.9
Google | Organization | 0.9

EDGES
Google | tastes_like | Something | 0.9`);

		expect(result.entities.map((entity) => entity.name)).toEqual(["Google"]);
		expect(result.edges).toEqual([]);
	});

	it("drops an edge whose ends are not both entities", () => {
		// graph.edges has foreign keys to graph.entities, so this would fail as a
		// constraint violation in the worker rather than as a bad extraction.
		const result = parseExtraction(`ENTITIES
Google | Organization | 0.9

EDGES
Larry Page | founded | Google | 0.9`);
		expect(result.edges).toEqual([]);
	});

	it("survives an empty reply and a header-only reply", () => {
		expect(parseExtraction("")).toEqual({ entities: [], edges: [] });
		expect(parseExtraction("ENTITIES\nEDGES")).toEqual({
			entities: [],
			edges: [],
		});
	});

	it("ignores a repeated header row and self-referential edges", () => {
		const result = parseExtraction(`ENTITIES
name | type | confidence
Google | Organization | 0.9

EDGES
source | relation | target | confidence
Google | part_of | Google | 0.9`);
		expect(result.entities).toHaveLength(1);
		expect(result.edges).toEqual([]);
	});
});

/* -------------------------------------------------------------------------- */
/* Crawl priority                                                             */
/* -------------------------------------------------------------------------- */

describe("crawl priority", () => {
	it("uses the specification's weights, which sum to one", () => {
		expect(
			WEIGHTS.demand +
				WEIGHTS.authority +
				WEIGHTS.freshness +
				WEIGHTS.graphImportance,
		).toBeCloseTo(1, 10);
		expect(WEIGHTS.demand).toBe(0.35);
	});

	it("computes the formula", () => {
		expect(
			priority({ demand: 1, authority: 1, freshness: 1, graphImportance: 1 }),
		).toBeCloseTo(1, 10);
		expect(
			priority({ demand: 1, authority: 0, freshness: 0, graphImportance: 0 }),
		).toBeCloseTo(0.35, 10);
	});

	it("weights demand above every other term", () => {
		// Demand-driven means demand actually dominates: a much-searched page with
		// nothing else going for it beats an authoritative one nobody wants.
		const demanded = priority({
			demand: 1,
			authority: 0,
			freshness: 0,
			graphImportance: 0,
		});
		const authoritative = priority({
			demand: 0,
			authority: 1,
			freshness: 0,
			graphImportance: 0,
		});
		expect(demanded).toBeGreaterThan(authoritative);
	});
});

/* -------------------------------------------------------------------------- */
/* Ranking                                                                    */
/* -------------------------------------------------------------------------- */

const document = (
	overrides: Partial<RetrievedDocument> = {},
): RetrievedDocument => ({
	docId: "d1",
	url: "https://example.com/a",
	domain: "example.com",
	path: "/a",
	title: "A page",
	snippet: "",
	body: "",
	chunks: [],
	authority: 0.5,
	publishedAt: 0,
	origin: "index",
	fusedScore: 0.5,
	agreement: 1,
	features: {},
	...overrides,
});

describe("passage selection", () => {
	it("prefers the chunk that answers the query, not the first one", () => {
		// A page's first paragraph is often navigation. Showing it because it is
		// first is how a good source looks irrelevant.
		const passages = selectPassages(
			"how many people died",
			document({
				chunks: [
					"Subscribe to our newsletter for updates and offers.",
					"Thirty-three people died directly in the fires.",
					"Related articles about Australian weather patterns.",
				],
			}),
			1,
		);
		expect(passages).toHaveLength(1);
		expect(passages[0].text).toContain("Thirty-three people died");
	});

	it("returns the selected passages in document order", () => {
		// They read as a summary in the author's order and as noise in any other.
		const passages = selectPassages(
			"deaths fires hectares",
			document({
				chunks: [
					"Hectares burned across the season.",
					"Unrelated filler text here.",
					"Deaths were recorded in several states.",
					"Fires continued into February.",
				],
			}),
			3,
		);
		const indexes = passages.map((passage) =>
			Number(passage.id.split("-").at(-1)),
		);
		expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
	});

	it("marks nothing as cited until the generator says so", () => {
		const passages = selectPassages(
			"anything",
			document({ chunks: ["text here"] }),
		);
		expect(passages.every((passage) => passage.cited === false)).toBe(true);
	});

	it("returns nothing for a document with no chunks", () => {
		expect(selectPassages("q", document({ chunks: [] }))).toEqual([]);
	});
});

const capability = (score: number): IndexedCapability => ({
	capId: "calendar.add_event",
	domain: "calendar.google.com",
	invocationName: "calendar.add_event",
	title: "Add Calendar Event",
	description: "",
	provider: "Google Calendar",
	auth: "OAuth",
	effects: "write-reversible",
	callable: false,
	score,
});

describe("capability selection", () => {
	it("surfaces actions readily for an action query", () => {
		const hits = selectCapabilities([capability(0.5)], "action", 1);
		expect(hits).toHaveLength(1);
		expect(hits[0].title).toBe("Add Calendar Event");
	});

	it("makes a capability beat a real result on an information query", () => {
		// A question that happens to be near a calendar action should not get a
		// button. The capability has to out-score the best document, not merely
		// exist.
		expect(selectCapabilities([capability(0.5)], "information", 1)).toEqual([]);
		expect(selectCapabilities([capability(2)], "information", 1)).toHaveLength(
			1,
		);
	});

	it("carries the effects tier and callability through untouched", () => {
		const [hit] = selectCapabilities([capability(5)], "action", 1);
		expect(hit.effects).toBe("write-reversible");
		expect(hit.callable).toBe(false);
	});
});

describe("indexConfidence", () => {
	it("is zero with no documents, so stage B always runs", () => {
		expect(indexConfidence([], true, 0)).toBe(0);
	});

	it("rises with both the top score and the depth of the result set", () => {
		const shallow = indexConfidence(
			[{ fusedScore: 1, features: {} }],
			true,
			0.9,
		);
		const deep = indexConfidence(
			Array.from({ length: 6 }, () => ({ fusedScore: 1, features: {} })),
			true,
			0.9,
		);
		// One good hit is a lucky match; six is an index that knows this topic.
		expect(deep).toBeGreaterThan(shallow);
	});

	it("never exceeds 1", () => {
		const many = Array.from({ length: 50 }, () => ({
			fusedScore: 9,
			features: {},
		}));
		expect(indexConfidence(many, true, 9)).toBeLessThanOrEqual(1);
		expect(indexConfidence(many, false, 99)).toBeLessThanOrEqual(1);
	});
});
