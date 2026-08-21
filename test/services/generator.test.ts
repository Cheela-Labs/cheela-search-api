import { describe, expect, it } from "vitest";
import { parse } from "../../src/services/generator/index.js";

/**
 * The comparison table is the one part of a response composed rather than
 * extracted, and `parse` is the only thing standing between a model's loose
 * output and a table the reader will believe. Its refusals matter as much as
 * its successes: a table dropped for being misshapen is correct, and a table
 * padded to fit is a claim nobody made.
 */

describe("parse", () => {
	it("reads an answer and suggestions as it always did", () => {
		const parsed = parse(
			"ANSWER: Redis is an in-memory store [1].\nSUGGESTIONS: redis vs memcached | redis persistence",
		);
		expect(parsed.answer).toBe("Redis is an in-memory store [1].");
		expect(parsed.suggestions).toEqual([
			"redis vs memcached",
			"redis persistence",
		]);
		expect(parsed.comparison).toBeUndefined();
	});

	it("still joins a wrapped answer", () => {
		const parsed = parse(
			"ANSWER: One sentence.\nAnd its continuation.\nSUGGESTIONS: a",
		);
		expect(parsed.answer).toBe("One sentence. And its continuation.");
	});

	it("does not fold a COMPARE line into the answer", () => {
		const parsed = parse(
			"ANSWER: Redis wins on data structures.\nCOMPARE: Redis | Memcached\nROW: Persistence | RDB + AOF * | None",
		);
		expect(parsed.answer).toBe("Redis wins on data structures.");
	});

	it("reads a table and the sources' preference", () => {
		const parsed = parse(
			[
				"ANSWER: Redis unless you need multi-core throughput [1].",
				"COMPARE: Redis | Memcached | Dragonfly",
				"ROW: Data structures | 9 types * | Strings only | Redis-compatible",
				"ROW: Threading | Single + I/O | Multi * | Multi *",
			].join("\n"),
		);
		expect(parsed.comparison).toEqual({
			subjects: ["Redis", "Memcached", "Dragonfly"],
			rows: [
				{
					criterion: "Data structures",
					cells: ["9 types", "Strings only", "Redis-compatible"],
					best: [0],
				},
				{
					criterion: "Threading",
					cells: ["Single + I/O", "Multi", "Multi"],
					best: [1, 2],
				},
			],
		});
	});

	it("keeps a row on which the sources take no side", () => {
		const parsed = parse(
			"ANSWER: a\nCOMPARE: A | B\nROW: Licence | BSD | Apache",
		);
		expect(parsed.comparison?.rows[0].best).toEqual([]);
	});

	it("drops a table whose rows do not match its columns", () => {
		// Three subjects, two values. Padding the third would assert an absence.
		const parsed = parse(
			"ANSWER: a\nCOMPARE: A | B | C\nROW: Licence | BSD | Apache",
		);
		expect(parsed.comparison).toBeUndefined();
	});

	it("drops a table with columns and no rows, and rows with no columns", () => {
		expect(parse("ANSWER: a\nCOMPARE: A | B").comparison).toBeUndefined();
		expect(
			parse("ANSWER: a\nROW: Licence | BSD | Apache").comparison,
		).toBeUndefined();
	});

	it("drops a single-column table, which is a list wearing a table's clothes", () => {
		expect(
			parse("ANSWER: a\nCOMPARE: A\nROW: Licence | BSD").comparison,
		).toBeUndefined();
	});

	it("caps columns and rows", () => {
		const rows = Array.from(
			{ length: 20 },
			(_, index) => `ROW: Criterion ${index} | a | b`,
		);
		const parsed = parse(["ANSWER: a", "COMPARE: A | B", ...rows].join("\n"));
		expect(parsed.comparison?.rows).toHaveLength(6);

		const wide = parse(
			[
				"ANSWER: a",
				"COMPARE: A | B | C | D | E | F",
				"ROW: x | 1 | 2 | 3 | 4",
			].join("\n"),
		);
		// Subjects capped to four; the row's four values then match, so it stands.
		expect(wide.comparison?.subjects).toHaveLength(4);
	});
});
