import { describe, expect, it } from "vitest";
import { classifyStructurally } from "../../src/services/intent/index.js";
import {
	answerConversion,
	parseConversion,
} from "../../src/services/intent/units.js";

/**
 * Unit conversion in the structural pass.
 *
 * The bug this closes, verbatim from production: "1 kg in pound" classified as
 * `information`, retrieved news, and had a model answer "I am sorry, but the
 * provided sources do not contain information about converting kilograms to
 * pounds. They focus on news related to an earthquake in Colombia."
 *
 * What matters most here is the refusals. A query wrongly read as a conversion
 * skips retrieval entirely and returns a number instead of a page of results,
 * which is a far worse failure than missing a conversion.
 */

describe("parseConversion", () => {
	it("reads the query that was broken", () => {
		const conversion = parseConversion("1 kg in pound");
		expect(conversion).not.toBeNull();
		expect(conversion?.from).toBe("kilograms");
		expect(conversion?.to).toBe("pounds");
		expect(conversion?.converted).toBeCloseTo(2.2046, 3);
	});

	it("reads every connector people actually type", () => {
		for (const query of [
			"1 kg to pounds",
			"1 kg in pounds",
			"1 kg as pounds",
			"1 kg into pounds",
		]) {
			expect(parseConversion(query)?.to).toBe("pounds");
		}
	});

	it("converts across the dimensions it claims to", () => {
		expect(parseConversion("450 gb to tb")?.converted).toBeCloseTo(0.45, 6);
		expect(parseConversion("180 c to f")?.converted).toBeCloseTo(356, 6);
		expect(parseConversion("10 km in miles")?.converted).toBeCloseTo(6.2137, 3);
		expect(parseConversion("3 hours in minutes")?.converted).toBe(180);
		expect(parseConversion("1 tib to gb")?.converted).toBeCloseTo(1099.51, 1);
	});

	it("handles thousands separators, decimals and negatives", () => {
		expect(parseConversion("1,500 m to km")?.converted).toBe(1.5);
		expect(parseConversion("2.5 kg in lbs")?.converted).toBeCloseTo(5.5116, 3);
		// -40 is the one temperature both scales agree on, which makes it the
		// best possible check that the offset is applied and not just the ratio.
		expect(parseConversion("-40 c to f")?.converted).toBeCloseTo(-40, 6);
	});

	describe("refuses", () => {
		it("a conversion between different dimensions", () => {
			// Answering this with a number would be worse than not answering.
			expect(parseConversion("10 kg to miles")).toBeNull();
			expect(parseConversion("5 seconds in gigabytes")).toBeNull();
		});

		it("a unit it does not know", () => {
			expect(parseConversion("3 parsecs to furlongs")).toBeNull();
			expect(parseConversion("12 widgets in gadgets")).toBeNull();
		});

		it("a conversion to itself", () => {
			expect(parseConversion("5 kg in kilograms")).toBeNull();
		});

		it("a real search that merely contains a number and a preposition", () => {
			// Each of these would return a number instead of a page of results.
			for (const query of [
				"1 kg of flour in a cake recipe",
				"how many pounds in a kg",
				"best 4k tv in 2026",
				"top 10 movies in 2025",
				"2 bedroom flat in london",
				"convert kg to pounds",
			]) {
				expect(parseConversion(query)).toBeNull();
			}
		});
	});
});

describe("answerConversion", () => {
	it("answers in a sentence, with the units agreeing in number", () => {
		// "1 kilograms" reads as a bug even when the number is right.
		expect(answerConversion(parseConversion("1 kg in pound") as never)).toBe(
			"1 kilogram is 2.2046 pounds.",
		);
		expect(answerConversion(parseConversion("450 gb to tb") as never)).toBe(
			"450 gigabytes is 0.45 terabytes.",
		);
	});
});

describe("classifyStructurally", () => {
	it("labels a conversion `utility` with no model call", () => {
		const result = classifyStructurally("1 kg in pound");
		expect(result?.intent).toBe("utility");
		expect(result?.conversion?.to).toBe("pounds");
	});

	it("leaves an ordinary query to the model", () => {
		// Falling through is the normal case, and a structural pass that claimed
		// more would be a structural pass that broke search.
		expect(classifyStructurally("how many pounds in a kilogram")).toBeNull();
		expect(classifyStructurally("colombia earthquake")).toBeNull();
	});

	it("still recognises a hostname, which shares this path", () => {
		const result = classifyStructurally("redis.io");
		expect(result?.intent).toBe("navigation");
		expect(result?.conversion).toBeUndefined();
	});
});
