import { describe, expect, it } from "vitest";
import type { RetrievedPage } from "../../src/domain/retrieval/fetch";
import {
	applySignals,
	lexicalRanker,
	type Passage,
	selectPassages,
} from "../../src/domain/retrieval/rank";

/**
 * Ranking, and the per-document cap that decides whether an answer can be
 * corroborated.
 *
 * The acceptance criterion for step 5 in PLAN.md is recall on a labelled set,
 * which does not exist yet — so what is asserted here is behaviour that has to
 * hold whatever the eventual numbers say: that distinctive terms beat common
 * ones, that no single page can own the whole context, and that the shortfall
 * from capping is filled rather than returned thin.
 */

const page = (
	domain: string,
	paragraphs: string[],
	title = domain,
): RetrievedPage => ({
	requestedUrl: `https://${domain}/`,
	finalUrl: `https://${domain}/`,
	domain,
	status: 200,
	extraction: {
		title,
		canonicalUrl: `https://${domain}/`,
		image: null,
		text: paragraphs.join("\n\n"),
		publishedAt: null,
		contentHash: "hash",
	},
});

/**
 * Long enough that two of these cannot share a chunk under the default 1200
 * character budget — so one paragraph is one passage and the counts below mean
 * what they say. At ~400 characters the chunker merged three paragraphs into
 * one passage and every cap assertion here was measuring the wrong thing.
 */
const pad = (subject: string) =>
	`${subject} ${"Filler sentence that carries no distinctive terminology at all. ".repeat(10)}`;

describe("lexicalRanker", () => {
	const passages = (texts: string[]): Passage[] =>
		texts.map((text, index) => ({
			ordinal: index,
			text,
			publishedAt: null,
			contentHash: `h${index}`,
			documentIndex: index,
			url: `https://d${index}.test/`,
			domain: `d${index}.test`,
			title: null,
			image: null,
			score: 0,
		}));

	it("ranks the passage containing the query's distinctive terms first", async () => {
		const ranked = await lexicalRanker.rank(
			"cloudflare workers cold start",
			passages([
				pad("An article about database indexing strategies."),
				pad("Cloudflare Workers have no cold start because isolates."),
				pad("A piece about continuous integration pipelines."),
			]),
			3,
		);
		expect(ranked[0]?.text).toContain("Cloudflare Workers have no cold start");
	});

	it("does not demote a passage for containing a term that is everywhere", async () => {
		// The `+ 1` in the IDF exists for this: without it a term present in more
		// than half the passages scores negative, and a passage is punished for
		// containing a word from the query.
		const ranked = await lexicalRanker.rank(
			"deployment",
			passages([
				pad("Deployment on one host."),
				pad("Deployment on another host."),
				pad("Deployment on a third host."),
				pad("Something entirely unrelated to the subject."),
			]),
			4,
		);
		expect(ranked[0]?.text).toContain("Deployment");
		for (const passage of ranked.slice(0, 3)) {
			expect(passage.score).toBeGreaterThan(0);
		}
	});

	it("returns passages unchanged when the query has no usable terms", async () => {
		const input = passages([pad("One."), pad("Two.")]);
		const ranked = await lexicalRanker.rank("!!! ???", input, 2);
		expect(ranked).toHaveLength(2);
	});

	it("handles an empty passage set", async () => {
		await expect(lexicalRanker.rank("anything", [], 12)).resolves.toEqual([]);
	});
});

describe("selectPassages", () => {
	it("returns nothing when no page produced text", async () => {
		await expect(selectPassages("q", [])).resolves.toEqual([]);
	});

	it("caps how much any one document contributes", async () => {
		// One page with ten strongly-matching paragraphs against two pages with
		// one each. Purely by score the first would take every slot.
		const dominant = page(
			"dominant.test",
			Array.from({ length: 10 }, (_, i) =>
				pad(`Cloudflare Workers cold start detail number ${i}.`),
			),
		);
		// Enough passages on the other two that the cap can actually be honoured.
		// With one each, six slots and a cap of two are unsatisfiable, and the
		// fill below correctly takes the shortfall from the dominant document —
		// which would make this assertion a test of the fill, not the cap.
		const second = page(
			"second.test",
			Array.from({ length: 3 }, (_, i) =>
				pad(`Cloudflare Workers cold start, briefly, ${i}.`),
			),
		);
		const third = page(
			"third.test",
			Array.from({ length: 3 }, (_, i) =>
				pad(`Cold start behaviour on Cloudflare Workers, ${i}.`),
			),
		);

		const selected = await selectPassages(
			"cloudflare workers cold start",
			[dominant, second, third],
			{ limit: 6, perDocumentLimit: 2 },
		);

		const fromDominant = selected.filter(
			(passage) => passage.domain === "dominant.test",
		);
		// An answer citing one source six times is a single-sourced answer that
		// looks corroborated.
		expect(fromDominant.length).toBeLessThanOrEqual(2);
		expect(new Set(selected.map((p) => p.domain)).size).toBe(3);
	});

	it("relaxes the cap rather than returning short when there is no diversity to be had", async () => {
		// The cap is a preference, not an invariant. With one document there is
		// no corroboration available at any cap, and four passages from one page
		// beats four when six were asked for.
		const only = page(
			"only.test",
			Array.from({ length: 8 }, (_, i) => pad(`Workers detail ${i}.`)),
		);

		const selected = await selectPassages("workers detail", [only], {
			limit: 6,
			perDocumentLimit: 2,
		});

		expect(selected).toHaveLength(6);
		expect(new Set(selected.map((p) => p.domain))).toEqual(
			new Set(["only.test"]),
		);
	});

	it("fills the shortfall rather than returning a thin context", async () => {
		// Only one document exists, so the cap cannot be honoured without
		// returning fewer passages than asked for.
		const only = page(
			"only.test",
			Array.from({ length: 8 }, (_, i) => pad(`Workers detail ${i}.`)),
		);

		const selected = await selectPassages("workers detail", [only], {
			limit: 6,
			perDocumentLimit: 2,
		});

		// A single-source answer is worse than a corroborated one; an empty
		// answer is worse than both.
		expect(selected).toHaveLength(6);
	});

	it("never returns the same passage twice when filling", async () => {
		const only = page(
			"only.test",
			Array.from({ length: 8 }, (_, i) => pad(`Workers detail ${i}.`)),
		);
		const selected = await selectPassages("workers detail", [only], {
			limit: 6,
			perDocumentLimit: 2,
		});

		const keys = selected.map((p) => `${p.documentIndex}:${p.ordinal}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("carries the citation fields the composer needs", async () => {
		const selected = await selectPassages(
			"workers",
			[page("a.test", [pad("Workers are fast.")], "A Title")],
			{ limit: 2 },
		);

		const [first] = selected;
		expect(first).toMatchObject({
			url: "https://a.test/",
			domain: "a.test",
			title: "A Title",
		});
		// The embedding cache key, carried from chunking.
		expect(first?.contentHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("takes a document's best passages, not its first", async () => {
		const mixed = page("mixed.test", [
			pad("An introduction about nothing in particular."),
			pad("More preamble with no relevant terminology."),
			pad("Cloudflare Workers cold start is zero milliseconds."),
		]);

		const selected = await selectPassages(
			"cloudflare workers cold start",
			[mixed],
			{ limit: 1, perDocumentLimit: 1 },
		);

		// Ranking happens across the whole pool before the cap is applied, so the
		// cap keeps the best passage rather than the earliest.
		expect(selected[0]?.text).toContain("cold start is zero milliseconds");
	});

	it("is swappable for another ranker without touching this function", async () => {
		// The seam that lets an embedding ranker be compared against BM25 by the
		// eval harness rather than replacing it on a hunch.
		const reversed = {
			name: "reverse",
			async rank(_query: string, pool: Passage[], limit: number) {
				return [...pool].reverse().slice(0, limit);
			},
		};

		const selected = await selectPassages(
			"anything",
			[page("a.test", [pad("First."), pad("Second."), pad("Third.")])],
			{ limit: 1, perDocumentLimit: 1 },
			reversed,
		);
		expect(selected[0]?.text).toContain("Third.");
	});
});

/**
 * The document signals — title match and recency.
 *
 * These are the two ways a passage can outrank an equally relevant one, and
 * every assertion here is about a bound rather than a direction. "Fresher wins"
 * is easy and useless; the useful properties are the ones that stop the signal
 * from becoming a retrieval mechanism.
 */
describe("applySignals", () => {
	const passage = (over: Partial<Passage>): Passage => ({
		ordinal: 0,
		text: "some text",
		contentHash: "h",
		documentIndex: 0,
		url: "https://example.com/a",
		domain: "example.com",
		title: null,
		image: null,
		publishedAt: null,
		score: 1,
		...over,
	});

	const scoreOf = (result: Passage[], url: string) =>
		result.find((p) => p.url === url)?.score ?? 0;

	it("promotes a passage whose document title matches the query", () => {
		const result = applySignals(
			[
				passage({ url: "https://a.test/", title: null, documentIndex: 0 }),
				passage({
					url: "https://b.test/",
					title: "hnsw index parameters",
					documentIndex: 1,
				}),
			],
			"hnsw index parameters",
		);

		expect(result[0]?.url).toBe("https://b.test/");
		// Bounded: a perfect title match is worth half again, never more. A weight
		// large enough to rescue an irrelevant passage would be doing retrieval.
		expect(scoreOf(result, "https://b.test/")).toBeCloseTo(1.5);
		expect(scoreOf(result, "https://a.test/")).toBeCloseTo(1);
	});

	/**
	 * The failure people mean when they say freshness ranking made results worse:
	 * a recent page about nothing floating over an old page with the answer.
	 * Multiplying a zero relevance score keeps it zero, structurally.
	 */
	it("cannot lift a passage that matches nothing", () => {
		const result = applySignals(
			[
				passage({
					url: "https://recent.test/",
					score: 0,
					title: "hnsw",
					publishedAt: new Date().toISOString(),
				}),
				passage({ url: "https://relevant.test/", score: 0.4 }),
			],
			"hnsw",
			{ freshness: "high" },
		);

		expect(result[0]?.url).toBe("https://relevant.test/");
		expect(scoreOf(result, "https://recent.test/")).toBe(0);
	});

	it("ignores recency entirely unless the query asked for it", () => {
		const now = Date.parse("2026-08-15T00:00:00Z");
		const input = [
			passage({
				url: "https://old.test/",
				publishedAt: "2020-01-01T00:00:00Z",
				documentIndex: 0,
			}),
			passage({
				url: "https://new.test/",
				publishedAt: "2026-08-14T00:00:00Z",
				documentIndex: 1,
			}),
		];

		const normal = applySignals(input, "query", { now, freshness: "normal" });
		expect(scoreOf(normal, "https://new.test/")).toBeCloseTo(1);
		expect(scoreOf(normal, "https://old.test/")).toBeCloseTo(1);

		const fresh = applySignals(input, "query", { now, freshness: "high" });
		expect(scoreOf(fresh, "https://new.test/")).toBeGreaterThan(
			scoreOf(fresh, "https://old.test/"),
		);
	});

	/**
	 * Most of the web declares no date. A signal that penalised absence would be
	 * ranking on whether a CMS emits Open Graph tags, so recency may only ever
	 * promote a page that proved it is recent.
	 */
	it("never penalises a page for declaring no date", () => {
		const now = Date.parse("2026-08-15T00:00:00Z");
		const result = applySignals(
			[
				passage({ url: "https://undated.test/", documentIndex: 0 }),
				passage({
					url: "https://ancient.test/",
					publishedAt: "2005-01-01T00:00:00Z",
					documentIndex: 1,
				}),
			],
			"query",
			{ now, freshness: "high" },
		);

		// The undated page scores exactly what it would have without this stage,
		// and an old dated page is not pushed below it.
		expect(scoreOf(result, "https://undated.test/")).toBeCloseTo(1);
		expect(scoreOf(result, "https://ancient.test/")).toBeCloseTo(1, 1);
	});

	it("treats a page dated slightly ahead of our clock as current, not extra fresh", () => {
		const now = Date.parse("2026-08-15T00:00:00Z");
		const result = applySignals(
			[
				passage({
					url: "https://skewed.test/",
					publishedAt: "2026-08-15T06:00:00Z",
					documentIndex: 0,
				}),
				passage({
					url: "https://now.test/",
					publishedAt: "2026-08-15T00:00:00Z",
					documentIndex: 1,
				}),
			],
			"query",
			{ now, freshness: "high" },
		);

		// Both clamp to "now" — a future date buys nothing extra.
		expect(scoreOf(result, "https://skewed.test/")).toBeCloseTo(
			scoreOf(result, "https://now.test/"),
		);
	});
});
