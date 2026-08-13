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
import type { AnswerBlock } from "../../src/shared/events";

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
		expect(spans).toEqual([{ kind: "text", text: "Claim ." }]);
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
