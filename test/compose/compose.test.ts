import { describe, expect, it } from "vitest";
import { splitSections, toSpans } from "../../src/domain/compose/citations";
import { extractiveComposer } from "../../src/domain/compose/extractive";
import { createLlmComposer } from "../../src/domain/compose/llm";
import {
	type CitedSource,
	sourcesFrom,
	swatchFor,
} from "../../src/domain/compose/types";
import type { Passage } from "../../src/domain/retrieval/rank";
import type { CompletionRequest, TextModel } from "../../src/infra/model/types";
import type { AnswerBlock, Span } from "../../src/shared/events";

/**
 * Composition, against a stub `Provider` rather than a model.
 *
 * The provider abstraction makes this complete without a key: what is being
 * tested is the prompt this stage builds and the parsing of what comes back,
 * and both are deterministic. What a real model *says* is the eval harness's
 * question, not this file's.
 */

const passage = (
	documentIndex: number,
	domain: string,
	text: string,
): Passage => ({
	ordinal: 0,
	text,
	contentHash: `hash-${documentIndex}`,
	documentIndex,
	url: `https://${domain}/page`,
	domain,
	title: `${domain} title`,
	image: null,
	score: 1,
});

/** A model that returns what it is told to, and records what it was asked. */
const stubModel = (
	reply: string,
): TextModel & { seen: CompletionRequest[] } => {
	const seen: CompletionRequest[] = [];
	return {
		name: "stub",
		seen,
		async complete(request) {
			seen.push(request);
			return reply;
		},
	};
};

async function collect(
	blocks: AsyncIterable<AnswerBlock>,
): Promise<AnswerBlock[]> {
	const out: AnswerBlock[] = [];
	for await (const block of blocks) out.push(block);
	return out;
}

describe("toSpans", () => {
	it("splits text and citations into the spans the surface renders", () => {
		expect(toSpans("Workers have no cold start [1].", 2)).toEqual([
			{ kind: "text", text: "Workers have no cold start " },
			{ kind: "cite", n: 1 },
			{ kind: "text", text: "." },
		]);
	});

	it("reads every form a model actually writes", () => {
		const commaForm = toSpans("A [1, 2] b.", 3).filter(
			(s) => s.kind === "cite",
		);
		const adjacentForm = toSpans("A [1][2] b.", 3).filter(
			(s) => s.kind === "cite",
		);
		expect(commaForm).toEqual([
			{ kind: "cite", n: 1 },
			{ kind: "cite", n: 2 },
		]);
		expect(adjacentForm).toEqual(commaForm);
	});

	it("drops a citation to a source that does not exist", () => {
		// A chip that opens nothing is worse than no chip: an uncited sentence
		// reads as unsupported, a broken citation reads as supported.
		const spans = toSpans("Claim [7].", 2);
		expect(spans.some((span) => span.kind === "cite")).toBe(false);
		// The claim itself survives — it is the attribution that was invented.
		//
		// This line read `"Claim ."` until 2026-08-15, encoding the defect rather
		// than catching it: the bracket was removed and the space before it was
		// not, so a real answer rendered "…thrive on bushfires ." A test can
		// pin a bug in place as easily as it pins behaviour.
		expect(spans).toEqual([{ kind: "text", text: "Claim." }]);
	});

	it("drops [0] and keeps the rest of a mixed bracket", () => {
		const cites = toSpans("A [0, 1] b.", 2).filter((s) => s.kind === "cite");
		expect(cites).toEqual([{ kind: "cite", n: 1 }]);
	});

	it("does not repeat the same citation inside one bracket run", () => {
		const cites = toSpans("A [1][1] b.", 2).filter((s) => s.kind === "cite");
		expect(cites).toEqual([{ kind: "cite", n: 1 }]);
	});

	it("leaves text with no citations alone", () => {
		expect(toSpans("Just a sentence.", 3)).toEqual([
			{ kind: "text", text: "Just a sentence." },
		]);
	});
});

describe("splitSections", () => {
	it("splits labelled output", () => {
		const sections = splitSections(
			"ANSWER: The short answer.\nWHY: The reason.\nTRADEOFF: The cost.",
			["ANSWER", "WHY", "TRADEOFF"],
		);
		expect(sections.map((s) => s.label)).toEqual(["ANSWER", "WHY", "TRADEOFF"]);
		expect(sections[0]?.text).toBe("The short answer.");
	});

	it("keeps a section's continuation lines", () => {
		const [section] = splitSections("WHY: First line.\nSecond line.", ["WHY"]);
		expect(section?.text).toBe("First line.\nSecond line.");
	});

	it("returns nothing when the model ignored the format", () => {
		expect(splitSections("Just prose, no labels.", ["ANSWER"])).toEqual([]);
	});
});

describe("sourcesFrom", () => {
	it("numbers sources by where the ranking first cites them", () => {
		const sources = sourcesFrom([
			passage(2, "b.test", "second document, ranked first"),
			passage(0, "a.test", "first document, ranked second"),
			passage(2, "b.test", "more from the same document"),
		]);

		// [1] should be what the answer leans on hardest, which is a property of
		// the ranking rather than of the upstream's ordering.
		expect(sources.map((source) => source.n)).toEqual([1, 2]);
		expect(sources[0]?.domain).toBe("b.test");
		// Both passages of one document land on that one source.
		expect(sources[0]?.passages).toHaveLength(2);
	});

	it("gives a stable colour per host", () => {
		expect(swatchFor("a.test")).toBe(swatchFor("a.test"));
		expect(swatchFor("a.test")).not.toBe(swatchFor("b.test"));
	});
});

describe("extractiveComposer", () => {
	const passages = [
		passage(0, "a.test", "Workers have no cold start at all."),
		passage(1, "b.test", "Fargate starts in seconds, not milliseconds."),
	];
	const sources = sourcesFrom(passages) as CitedSource[];

	it("says plainly that it is quoting rather than answering", async () => {
		const blocks = await collect(
			extractiveComposer.compose({ query: "cold start", passages, sources }),
		);
		const answer = blocks[0];
		expect(answer?.kind).toBe("answer");
		if (answer?.kind === "answer") {
			expect(answer.spans[0]).toMatchObject({ kind: "text" });
			expect(JSON.stringify(answer.spans)).toContain("No composer model");
		}
	});

	it("quotes passages verbatim and attributes each one", async () => {
		const blocks = await collect(
			extractiveComposer.compose({ query: "cold start", passages, sources }),
		);
		const notes = blocks.filter((block) => block.kind === "note");

		expect(notes).toHaveLength(2);
		// Verbatim: nothing here paraphrases, so nothing here can misreport a
		// source.
		expect(JSON.stringify(notes[0])).toContain("Workers have no cold start");
		expect(notes[0]?.kind === "note" && notes[0].spans.at(-1)).toEqual({
			kind: "cite",
			n: 1,
		});
	});

	it("says so when nothing was retrieved", async () => {
		const blocks = await collect(
			extractiveComposer.compose({ query: "x", passages: [], sources: [] }),
		);
		expect(blocks).toHaveLength(1);
		expect(JSON.stringify(blocks[0])).toContain("Nothing was retrieved");
	});
});

describe("llm composer", () => {
	const passages = [
		passage(0, "a.test", "Workers have no cold start."),
		passage(1, "b.test", "Fargate takes seconds to start."),
	];
	const sources = sourcesFrom(passages) as CitedSource[];

	it("labels passages as data and says they are not instructions", async () => {
		const model = stubModel("ANSWER: Use Workers [1].");
		await collect(
			createLlmComposer({ model }).compose({
				query: "cold start",
				passages,
				sources,
			}),
		);

		const [request] = model.seen;
		const system = request?.system ?? "";
		const user = request?.user ?? "";

		// Page content reaches this stage having passed no screen. The fence and
		// the rule about it are the structural half of the containment; the
		// composer having no tools is the other.
		expect(user).toContain("<SOURCES>");
		expect(system).toContain("data, not instruction");
		// No tools exist to pass — `TextModel` has nowhere to put them, which is
		// the containment made structural rather than remembered.
		expect(Object.keys(request ?? {})).not.toContain("capabilities");
	});

	it("numbers passages in the prompt the way citations refer to them", async () => {
		const model = stubModel("ANSWER: x [1].");
		await collect(
			createLlmComposer({ model }).compose({
				query: "q",
				passages,
				sources,
			}),
		);
		const user = model.seen[0]?.user ?? "";
		expect(user).toContain("[1] (a.test)");
		expect(user).toContain("[2] (b.test)");
	});

	it("maps labelled sections onto answer and note blocks", async () => {
		const model = stubModel(
			"ANSWER: Use Workers [1].\nWHY: They have no cold start [1].\nTRADEOFF: CPU is capped [2].",
		);
		const blocks = await collect(
			createLlmComposer({ model }).compose({
				query: "q",
				passages,
				sources,
			}),
		);

		expect(blocks.map((block) => block.kind)).toEqual([
			"answer",
			"note",
			"note",
		]);
		expect(blocks.map((block) => block.id)).toEqual([
			"answer",
			"why",
			"tradeoff",
		]);
	});

	it("renders unlabelled prose as one answer rather than discarding it", async () => {
		// The model ignored the format. A correct answer in the wrong shape is
		// still a correct answer.
		const model = stubModel("Workers are the right choice here [1].");
		const blocks = await collect(
			createLlmComposer({ model }).compose({
				query: "q",
				passages,
				sources,
			}),
		);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.kind).toBe("answer");
	});

	it("strips a citation the model invented", async () => {
		const model = stubModel("ANSWER: Use Workers [9].");
		const blocks = await collect(
			createLlmComposer({ model }).compose({
				query: "q",
				passages,
				sources,
			}),
		);
		const answer = blocks[0];
		expect(
			answer?.kind === "answer" && answer.spans.some((s) => s.kind === "cite"),
		).toBe(false);
	});

	it("emits nothing rather than an empty block when the model said nothing", async () => {
		const model = stubModel("   ");
		const blocks = await collect(
			createLlmComposer({ model }).compose({
				query: "q",
				passages,
				sources,
			}),
		);
		expect(blocks).toEqual([]);
	});
});

/**
 * The answer *schema*, which is a product decision the prompt encodes.
 *
 * These came out of a review of a real answer for "Australian wildfire",
 * scored 6.5/10 against what Perplexity and Google's AI Mode set as the
 * expectation. Two of the three faults were schema faults rather than
 * retrieval faults, which is why they are asserted here.
 */
describe("answer schema by query type", () => {
	const passages = [
		passage(
			0,
			"a.test",
			"The 2019-20 Black Summer fires burned 24 million hectares.",
		),
		passage(1, "b.test", "Eucalyptus oils are highly flammable."),
	];
	const sources = sourcesFrom(passages) as CitedSource[];

	async function systemFor(query: string): Promise<string> {
		const model = stubModel("ANSWER: Something [1].");
		await collect(
			createLlmComposer({ model }).compose({ query, passages, sources }),
		);
		return model.seen[0]?.system ?? "";
	}

	/**
	 * The fault the review actually named.
	 *
	 * TRADEOFF was being filled because it was listed, not because a tradeoff
	 * existed — "Australian wildfire" produced a paragraph about how results
	 * depend on the discovery service, which answers a question nobody asked.
	 * The old prompt already said "Omit this line if there is nothing real to
	 * say", so the fix is not a stronger instruction; it is not offering the
	 * section.
	 */
	it("offers no TRADEOFF section on a query that is not a decision", async () => {
		const system = await systemFor("australian wildfire");
		expect(system).not.toContain("TRADEOFF");
		expect(system).toContain("FACTS:");
	});

	it("offers TRADEOFF when the query is comparative", async () => {
		for (const query of [
			"react vs vue",
			"mongodb versus postgres",
			"difference between grpc and rest",
			"should i use tailwind or css modules",
		]) {
			expect(await systemFor(query)).toContain("TRADEOFF:");
		}
	});

	/** A false positive brings back the exact failure this removes. */
	it("does not mistake an ordinary question for a comparison", async () => {
		for (const query of [
			"australian wildfire",
			"how does bm25 ranking work",
			"pgvector hnsw index parameters",
		]) {
			expect(await systemFor(query)).not.toContain("TRADEOFF");
		}
	});

	/** "24 million hectares" beats "fires are common in Australia". */
	it("asks for specifics and for the dominant instance of a broad subject", async () => {
		const system = await systemFor("australian wildfire");
		expect(system).toContain("dates, quantities, names, scale");
		expect(system.toLowerCase()).toContain("dominant instance");
	});

	it("turns RELATED into a suggestions block, not a note", async () => {
		const model = stubModel(
			[
				"ANSWER: The Black Summer fires burned 24 million hectares [1].",
				"FACTS: 33 people died [1].",
				"RELATED: black summer bushfire timeline",
				"- why australia has bushfires [1]",
				"3. current australian fire warnings",
			].join("\n"),
		);
		const blocks = await collect(
			createLlmComposer({ model }).compose({
				query: "australian wildfire",
				passages,
				sources,
			}),
		);

		const suggestions = blocks.find((b) => b.kind === "suggestions");
		expect(suggestions).toBeDefined();
		if (suggestions?.kind !== "suggestions") return;

		// Bullets and numbering stripped, and the citation marker removed — a
		// button that runs a search must not have "[1]" in its label.
		expect(suggestions.queries).toEqual([
			"black summer bushfire timeline",
			"why australia has bushfires",
			"current australian fire warnings",
		]);
		// Not rendered as prose alongside the answer.
		expect(blocks.some((b) => b.kind === "note" && b.label === "RELATED")).toBe(
			false,
		);
	});

	it("caps suggestions at three", async () => {
		const model = stubModel(
			["ANSWER: x [1].", "RELATED: a", "b", "c", "d", "e"].join("\n"),
		);
		const blocks = await collect(
			createLlmComposer({ model }).compose({
				query: "australian wildfire",
				passages,
				sources,
			}),
		);
		const suggestions = blocks.find((b) => b.kind === "suggestions");
		if (suggestions?.kind !== "suggestions") throw new Error("no suggestions");
		expect(suggestions.queries).toHaveLength(3);
	});
});

/**
 * What a dropped citation leaves behind.
 *
 * Invented citations are dropped and the claim kept — deliberate, and the
 * right call. But the space in front of the bracket survived, so a real answer
 * read "eucalyptus forests have evolved to thrive on bushfires ." The reader
 * gets a typographic tell for a failure they were never meant to notice.
 */
describe("text around a dropped citation", () => {
	const passages = [passage(0, "a.test", "One real source.")];
	const sources = sourcesFrom(passages) as CitedSource[];

	function textOf(spans: Span[]): string {
		return spans.map((s) => (s.kind === "text" ? s.text : `[${s.n}]`)).join("");
	}

	it("closes the space before punctuation when the citation is invented", async () => {
		const model = stubModel("ANSWER: Fires shaped the continent [7].");
		const blocks = await collect(
			createLlmComposer({ model }).compose({
				query: "australian wildfire",
				passages,
				sources,
			}),
		);
		const answer = blocks.find((b) => b.kind === "answer");
		if (answer?.kind !== "answer") throw new Error("no answer");

		expect(textOf(answer.spans)).toBe("Fires shaped the continent.");
		expect(textOf(answer.spans)).not.toContain(" .");
	});

	/** Between two words the space is correct — collapsing it would join them. */
	it("keeps the space when the citation sits mid-sentence", async () => {
		const model = stubModel("ANSWER: Fires [7] shaped the continent [1].");
		const blocks = await collect(
			createLlmComposer({ model }).compose({
				query: "australian wildfire",
				passages,
				sources,
			}),
		);
		const answer = blocks.find((b) => b.kind === "answer");
		if (answer?.kind !== "answer") throw new Error("no answer");

		expect(textOf(answer.spans)).toBe("Fires shaped the continent [1].");
	});

	/** A real citation is untouched by any of this. */
	it("leaves a valid citation exactly where it was", async () => {
		const model = stubModel("ANSWER: Fires shaped the continent [1].");
		const blocks = await collect(
			createLlmComposer({ model }).compose({
				query: "australian wildfire",
				passages,
				sources,
			}),
		);
		const answer = blocks.find((b) => b.kind === "answer");
		if (answer?.kind !== "answer") throw new Error("no answer");

		expect(textOf(answer.spans)).toBe("Fires shaped the continent [1].");
	});
});
