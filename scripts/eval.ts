import { readFile } from "node:fs/promises";
import { composer } from "../src/domain/compose";
import { runPipeline } from "../src/domain/pipeline";
import type {
	RetrievalStats,
	RetrievedPage,
} from "../src/domain/retrieval/fetch";
import type { Passage } from "../src/domain/retrieval/rank";
import { classifier } from "../src/domain/route";
import { PostgresDocumentStore } from "../src/infra/db/document-store";
import { pool } from "../src/infra/db/pool";
import { PostgresQueryCache } from "../src/infra/db/query-cache";
import { egress } from "../src/infra/egress";
import { createOpenRouterModel } from "../src/infra/model";
import { upstream } from "../src/infra/upstream";
import { withQueryCache } from "../src/infra/upstream/cached-rotation";
import { config } from "../src/shared/config";
import type { AnswerBlock, Intent, Source } from "../src/shared/events";
import { type Judgement, judge } from "./judge";

/**
 * The eval harness — PLAN.md's parallel track.
 *
 * Its whole argument, quoted because it is the reason this exists rather than
 * a nicer retrieval stage: *"Every stage here has a plausible-sounding
 * improvement that makes end-to-end quality worse — a better embedding model
 * that loses proper nouns, a cheaper extractor that drops the answer. Without
 * per-stage measurement you will ship all of them and be unable to tell which
 * one did the damage."*
 *
 * So the output is **per stage**, not one number. A run that gets worse should
 * say which stage got worse.
 *
 * ## What it does not do
 *
 * It does not assert. This is a measurement tool, not a test — it exits 0
 * whether the numbers are good or bad, because a gate that fails the build on
 * a metric with an LLM in it makes the build a coin flip. The gate table is
 * printed for a human to read and act on.
 *
 * Run: `pnpm --filter @cheela/search-api eval`
 */

type Label = {
	id?: string;
	query: string;
	why?: string;
	intent?: Intent;
	expectDomains?: string[];
	mustMention?: string[];
	/**
	 * Facts a correct answer has to have *found*, checked against the passages
	 * rather than against the prose.
	 *
	 * The label step 5 needs, and deliberately not the same field as
	 * `mustMention`: one asks whether the answer said a thing, this one asks
	 * whether retrieval ever put the thing in front of the composer. A query
	 * labelled with both splits a failure into the stage that caused it.
	 */
	mustRetrieve?: string[];
	expectEmpty?: boolean;
};

type Result = {
	label: Label;
	id: string;
	ok: boolean;
	error?: string;
	durationMs: number;
	intent: Intent | null;
	sources: Source[];
	blocks: AnswerBlock[];
	retrieval: RetrievalStats | null;
	/** What survived ranking, and what it was ranked from. See `attribute`. */
	passages: Passage[];
	pages: RetrievedPage[];
	answerText: string;
	judgement?: Judgement;
};

const args = process.argv.slice(2);
const only = flagValue("--only");
const useJudge = args.includes("--judge");
const judgeModelName = flagValue("--judge-model") ?? config.COMPOSER_MODEL;
const limit = Number(flagValue("--limit") ?? "0");

/**
 * The judge's model, built separately from the composer's.
 *
 * Separately on purpose: `--judge-model` lets the grader be a different family
 * from `COMPOSER_MODEL`, which is the cheapest way to stop a model marking its
 * own homework. It defaults to the same one, which is honest but weak.
 */
const judgeModel = config.COMPOSER_API_KEY
	? createOpenRouterModel(config.COMPOSER_API_KEY, judgeModelName, egress)
	: null;

function flagValue(flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
}

/**
 * JSONC by hand, because the label file carries reasoning next to each query
 * and JSON has no comments. Only whole-line `//` is stripped — a `//` inside a
 * string is left alone, which matters because half these queries are URLs.
 */
async function loadLabels(): Promise<Label[]> {
	const path = new URL("../eval/queries.jsonl", import.meta.url).pathname;
	const text = await readFile(path, "utf8");

	const labels: Label[] = [];
	for (const [index, raw] of text.split("\n").entries()) {
		const line = raw.trim();
		if (!line || line.startsWith("//")) continue;
		try {
			labels.push(JSON.parse(line) as Label);
		} catch (error) {
			throw new Error(
				`eval/queries.jsonl line ${index + 1} is not valid JSON: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
	return labels;
}

function textOf(blocks: AnswerBlock[]): string {
	const spans: string[] = [];
	for (const block of blocks) {
		if ("spans" in block) {
			for (const span of block.spans) {
				if (span.kind === "text") spans.push(span.text);
			}
		}
	}
	return spans.join(" ");
}

function citationsOf(blocks: AnswerBlock[]): number[] {
	const cites: number[] = [];
	for (const block of blocks) {
		if ("spans" in block) {
			for (const span of block.spans) {
				if (span.kind === "cite") cites.push(span.n);
			}
		}
	}
	return cites;
}

async function runOne(label: Label): Promise<Result> {
	const id = label.id ?? label.query.slice(0, 24);
	const started = Date.now();

	const sources: Source[] = [];
	const blocks: AnswerBlock[] = [];
	let intent: Intent | null = null;
	let retrieval: RetrievalStats | null = null;
	let passages: Passage[] = [];
	let pages: RetrievedPage[] = [];
	let error: string | undefined;

	const deps = {
		upstream: withQueryCache(upstream, new PostgresQueryCache(pool)),
		egress,
		composer,
		classifier,
		documents: new PostgresDocumentStore(pool),
		// No query log. The harness is not demand — writing eval queries into
		// the permanent record would poison the corpus PLAN.md keeps it for.
		onRetrieval: (stats: RetrievalStats) => {
			retrieval = stats;
		},
		onPassages: (
			kept: readonly Passage[],
			available: readonly RetrievedPage[],
		) => {
			passages = [...kept];
			pages = [...available];
		},
	};

	try {
		for await (const event of runPipeline(label.query, deps)) {
			if (event.type === "intent") intent = event.intent;
			else if (event.type === "source") sources.push(event.source);
			else if (event.type === "block") blocks.push(event.block);
			else if (event.type === "error") error = event.message;
		}
	} catch (thrown) {
		error = thrown instanceof Error ? thrown.message : String(thrown);
	}

	return {
		label,
		id,
		ok: !error,
		error,
		durationMs: Date.now() - started,
		intent,
		sources,
		blocks,
		retrieval,
		passages,
		pages,
		answerText: textOf(blocks),
	};
}

/** A metric over the subset of queries that carry the label it needs. */
type Metric = { value: number | null; n: number; note?: string };

function ratio(hits: number, n: number, note?: string): Metric {
	return { value: n === 0 ? null : hits / n, n, note };
}

function routingAccuracy(results: Result[]): Metric {
	const labelled = results.filter((r) => r.label.intent);
	const right = labelled.filter((r) => r.intent === r.label.intent).length;
	return ratio(right, labelled.length);
}

/**
 * Domain recall, macro-averaged.
 *
 * Per query then averaged, rather than pooling every expected domain into one
 * ratio. Pooled, a single query labelled with eight domains would outweigh
 * four queries labelled with one, and the set would silently be measuring
 * whichever query someone labelled most thoroughly.
 */
function domainRecall(results: Result[]): Metric {
	const labelled = results.filter((r) => (r.label.expectDomains ?? []).length);
	if (labelled.length === 0) return ratio(0, 0);

	let total = 0;
	for (const result of labelled) {
		const got = new Set(result.sources.map((s) => s.domain));
		const want = result.label.expectDomains as string[];
		const found = want.filter((domain) =>
			[...got].some((d) => d === domain || d.endsWith(`.${domain}`)),
		).length;
		total += found / want.length;
	}
	return ratio(total, labelled.length);
}

/**
 * Failures nobody intends to fix.
 *
 * A `401`, `403` or `451` is a site declining to serve an identified bot.
 * PLAN.md refuses to spoof a browser user agent to get around that, so these
 * are a category we accept rather than a number we drive down.
 */
const NOT_OURS = new Set(["refused-by-site"]);

/** Phase 0 gate: > 0.90. Exact, from the pipeline rather than a stage label. */
function extractionRate(results: Result[]): Metric {
	const withStats = results.filter((r) => r.retrieval);
	if (withStats.length === 0) return ratio(0, 0);

	let requested = 0;
	let extracted = 0;
	for (const result of withStats) {
		requested += (result.retrieval as RetrievalStats).requested;
		extracted += (result.retrieval as RetrievalStats).extracted;
	}
	return ratio(extracted, requested, "pages, pooled");
}

/**
 * The same rate over pages we were actually allowed to read.
 *
 * **This is the number to work against**, and the raw rate is the one to
 * report. PLAN.md said the 0.90 gate "needs redefining before it can be met,
 * and not by improving extraction" — this is that redefinition, with a
 * measurement behind it: on the seed set, 42% of failures are sites refusing an
 * identified bot. Chasing the raw rate means either accepting a target that
 * cannot be hit or spoofing a user agent to hit it, and the second is refused.
 *
 * Keeping both visible matters. The raw rate is what a reader of the answer
 * experiences — a refused page is still a page missing from the answer — while
 * this one is what an engineer can move.
 */
function addressableExtraction(results: Result[]): Metric {
	const withStats = results.filter((r) => r.retrieval);
	if (withStats.length === 0) return ratio(0, 0);

	let requested = 0;
	let extracted = 0;
	for (const result of withStats) {
		const stats = result.retrieval as RetrievalStats;
		const refused = Object.entries(stats.failures)
			.filter(([reason]) => NOT_OURS.has(reason))
			.reduce((n, [, count]) => n + count, 0);

		requested += stats.requested - refused;
		extracted += stats.extracted;
	}
	return ratio(extracted, requested, "readable pages");
}

/**
 * Citation *validity*, which is not citation faithfulness.
 *
 * Deterministic and free: does every `cite n` resolve to a source that was
 * actually emitted. The composer already drops invented citations, so this
 * should read 1.0 — it is a regression guard on that behaviour, not a quality
 * measure. Faithfulness — whether the cited passage supports the claim — is
 * the >0.95 gate and needs the judge.
 */
function citationValidity(results: Result[]): Metric {
	let cites = 0;
	let valid = 0;
	for (const result of results) {
		const ns = new Set(result.sources.map((s) => s.n));
		for (const n of citationsOf(result.blocks)) {
			cites += 1;
			if (ns.has(n)) valid += 1;
		}
	}
	return ratio(valid, cites, "citations");
}

/** Cheap correctness proxy: did the answer mention what it had to. */
function mentionRate(results: Result[]): Metric {
	const labelled = results.filter((r) => (r.label.mustMention ?? []).length);
	if (labelled.length === 0) return ratio(0, 0);

	let total = 0;
	for (const result of labelled) {
		const text = result.answerText.toLowerCase();
		const want = result.label.mustMention as string[];
		total +=
			want.filter((term) => text.includes(term.toLowerCase())).length /
			want.length;
	}
	return ratio(total, labelled.length);
}

/**
 * Where a fact that a correct answer needed was lost.
 *
 * This is step 5's acceptance criterion — *"recall on the labeled set clears
 * the bar, and the numbers are per-stage rather than end-to-end"* — made
 * computable. A single recall number says the answer was missing something; it
 * cannot say which stage dropped it, and the four stages have nothing in
 * common but the symptom.
 *
 * Checked at three points, so each fact lands in exactly one bucket:
 *
 * - `answered`    — it made it all the way through.
 * - `composition` — a passage carried it and the answer did not use it. The
 *                   retrieval stages did their job.
 * - `ranking`     — a page carried it and no surviving passage did. **The
 *                   ranker or the chunker dropped it**, and this is the only
 *                   bucket a better ranker can move.
 * - `retrieval`   — nothing we read carried it at all. Upstream did not return
 *                   the page, or extraction lost it.
 *
 * Substring matching, lowercased, for the same reason `mustMention` uses it:
 * it costs no model call, and the failure it catches — the fact simply is not
 * there — is the one worth catching cheaply.
 */
type LossStage = "answered" | "composition" | "ranking" | "retrieval";

const LOSS_STAGES: LossStage[] = [
	"answered",
	"composition",
	"ranking",
	"retrieval",
];

function attribute(result: Result): LossStage[] {
	const facts = result.label.mustRetrieve ?? [];
	if (facts.length === 0) return [];

	const pageText = result.pages
		.map((page) => page.extraction.text)
		.join("\n")
		.toLowerCase();
	const passageText = result.passages
		.map((passage) => passage.text)
		.join("\n")
		.toLowerCase();
	const answer = result.answerText.toLowerCase();

	return facts.map((fact) => {
		const needle = fact.toLowerCase();
		if (answer.includes(needle)) return "answered";
		if (passageText.includes(needle)) return "composition";
		if (pageText.includes(needle)) return "ranking";
		return "retrieval";
	});
}

/**
 * Step 5's headline: of the facts a correct answer needed, how many did
 * ranking actually put in front of the composer.
 *
 * Macro-averaged for the same reason `domainRecall` is — pooled, one query
 * labelled with eight facts would outweigh four labelled with one, and the
 * metric would quietly become a measure of whichever query somebody labelled
 * most thoroughly.
 */
function passageRecall(results: Result[]): Metric {
	const labelled = results.filter((r) => (r.label.mustRetrieve ?? []).length);
	if (labelled.length === 0) return ratio(0, 0);

	let total = 0;
	for (const result of labelled) {
		const stages = attribute(result);
		const kept = stages.filter(
			(stage) => stage === "answered" || stage === "composition",
		).length;
		total += kept / stages.length;
	}
	return ratio(total, labelled.length);
}

/**
 * Of the facts we actually fetched, how many the ranker then threw away.
 *
 * **This is the number that decides the embedding stage PLAN.md deferred**, and
 * it is the reason step 5 can be accepted or rejected on evidence rather than
 * on taste. The plan's position is that BM25 over "a hundred passages from
 * pages an upstream engine already judged relevant" is a strong baseline, and
 * that a semantic ranker "earns its model call per query on the request path or
 * it does not, and the eval harness is what says which."
 *
 * This is that test. A loss near zero means every fact that was fetched
 * survived into the context, so there is no headroom for a better ranker to
 * buy — a semantic reranker would be paying a per-query model call for
 * passages BM25 was already keeping. A large loss is the opposite finding and
 * the mandate to build it.
 *
 * Pooled rather than macro-averaged, and unlike `passageRecall` that is the
 * right choice here: this is a diagnostic about the ranker, not a quality score
 * per query, and every fact that reached the pool is one independent
 * observation of what the ranker did with it.
 */
function rankerLoss(results: Result[]): Metric {
	let available = 0;
	let lost = 0;
	for (const result of results) {
		for (const stage of attribute(result)) {
			// Facts never retrieved are not the ranker's to lose.
			if (stage === "retrieval") continue;
			available += 1;
			if (stage === "ranking") lost += 1;
		}
	}
	return ratio(lost, available, "facts reaching the pool");
}

/**
 * Did the queries labelled unanswerable stay quiet.
 *
 * The one metric where a *high* answer rate is the failure. A search engine
 * that always produces a confident paragraph is not answering; it is
 * generating, and this is the only check in the set that can tell.
 */
/** Every named failure reason, most common first. */
function failureBreakdown(results: Result[]): [string, number][] {
	const counts = new Map<string, number>();
	for (const result of results) {
		for (const [reason, n] of Object.entries(
			result.retrieval?.failures ?? {},
		)) {
			counts.set(reason, (counts.get(reason) ?? 0) + n);
		}
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** Macro-averaged over queries that produced a judgeable verdict. */
function faithfulness(results: Result[]): Metric {
	const judged = results.filter(
		(r) => r.judgement?.faithfulness !== null && r.judgement,
	);
	if (judged.length === 0) return ratio(0, 0);
	const total = judged.reduce(
		(n, r) => n + (r.judgement?.faithfulness ?? 0),
		0,
	);
	return ratio(total, judged.length);
}

function correctness(results: Result[]): Metric {
	const judged = results.filter(
		(r) => r.judgement?.correctness !== null && r.judgement,
	);
	if (judged.length === 0) return ratio(0, 0);
	const total = judged.reduce((n, r) => n + (r.judgement?.correctness ?? 0), 0);
	return ratio(total, judged.length);
}

function restraint(results: Result[]): Metric {
	const labelled = results.filter((r) => r.label.expectEmpty);
	const quiet = labelled.filter((r) => r.sources.length === 0).length;
	return ratio(quiet, labelled.length);
}

function pct(metric: Metric): string {
	if (metric.value === null) return "     — ";
	return `${(metric.value * 100).toFixed(1).padStart(6)}%`;
}

function row(name: string, metric: Metric, bar?: number): string {
	const mark =
		metric.value === null || bar === undefined
			? " "
			: metric.value >= bar
				? "✓"
				: "✗";
	const target = bar === undefined ? "" : ` (bar ${(bar * 100).toFixed(0)}%)`;
	const n =
		metric.n === 0
			? "no labels"
			: `n=${metric.n}${metric.note ? ` ${metric.note}` : ""}`;
	return `  ${mark} ${name.padEnd(24)} ${pct(metric)}   ${n}${target}`;
}

async function main(): Promise<void> {
	let labels = await loadLabels();
	if (only) labels = labels.filter((l) => l.id === only || l.query === only);
	if (limit > 0) labels = labels.slice(0, limit);

	if (labels.length === 0) {
		console.error("No queries matched.");
		process.exit(1);
	}

	if (useJudge && !judgeModel) {
		console.error(
			"--judge needs COMPOSER_API_KEY set: the judge is a model call.",
		);
		process.exit(1);
	}

	console.log(
		`\nRunning ${labels.length} quer${labels.length === 1 ? "y" : "ies"}` +
			`${useJudge ? ` with the judge (${judgeModelName})` : " (deterministic metrics only)"}\n`,
	);

	const results: Result[] = [];
	for (const label of labels) {
		// Sequential on purpose. Concurrent queries share the caches and the
		// upstream rate limit, so a parallel run measures contention as much as
		// retrieval — and the numbers would move with the machine.
		const result = await runOne(label);
		if (useJudge && judgeModel && result.ok) {
			result.judgement = await judge(
				judgeModel,
				label.query,
				result.blocks,
				result.sources,
				result.answerText,
			);
		}
		results.push(result);

		const status = result.ok ? "ok " : "ERR";
		console.log(
			`  ${status} ${result.id.padEnd(20)} ${String(result.durationMs).padStart(6)}ms  ` +
				`${String(result.sources.length).padStart(2)} sources  ` +
				`${String(result.blocks.length).padStart(2)} blocks` +
				`${result.error ? `  — ${result.error}` : ""}`,
		);
	}

	console.log("\n── Per stage ──────────────────────────────────────────────");
	console.log(row("routing accuracy", routingAccuracy(results)));
	console.log(row("extraction rate", extractionRate(results)));
	console.log(row("  ↳ addressable", addressableExtraction(results), 0.9));
	console.log(row("domain recall", domainRecall(results)));
	console.log(row("passage recall", passageRecall(results)));
	console.log(row("  ↳ lost by ranking", rankerLoss(results)));
	console.log(row("citation validity", citationValidity(results), 1));
	console.log(row("must-mention", mentionRate(results)));
	console.log(row("restraint on empty", restraint(results)));

	/*
	  The composition of the failures, not just the rate.

	  PLAN.md argues the 0.90 gate "needs redefining before it can be met, and
	  not by improving extraction": a `403` is a site declining to be read by an
	  identified bot, and spoofing a browser user agent to get past it is
	  refused. A single percentage cannot tell a fixable parser bug from a
	  deliberate refusal, and only one of those is worth engineering time.
	*/
	const failures = failureBreakdown(results);
	if (failures.length > 0) {
		console.log(
			"\n── Why pages did not extract ──────────────────────────────",
		);
		const total = failures.reduce((n, [, count]) => n + count, 0);
		for (const [reason, count] of failures) {
			const share = ((count / total) * 100).toFixed(0).padStart(3);
			console.log(
				`    ${reason.padEnd(22)} ${String(count).padStart(3)}  ${share}%`,
			);
		}
	}

	/*
	  Step 5's criterion, in the form that makes it actionable: not how many
	  facts were missing, but which stage lost each one. A recall number alone
	  sends you to improve the ranker when the page was never fetched.
	*/
	const attribution = results.flatMap(attribute);
	if (attribution.length > 0) {
		console.log(
			"\n── Where a needed fact was lost ───────────────────────────",
		);
		const owner: Record<LossStage, string> = {
			answered: "",
			composition: "composer had it, did not use it",
			ranking: "ranker or chunker dropped it",
			retrieval: "never fetched, or extraction lost it",
		};
		for (const stage of LOSS_STAGES) {
			const count = attribution.filter((s) => s === stage).length;
			if (count === 0) continue;
			const share = ((count / attribution.length) * 100).toFixed(0).padStart(3);
			console.log(
				`    ${stage.padEnd(14)} ${String(count).padStart(3)}  ${share}%  ${owner[stage]}`,
			);
		}
	}

	if (useJudge) {
		console.log(
			"\n── Judged ─────────────────────────────────────────────────",
		);
		console.log(row("citation faithfulness", faithfulness(results), 0.95));
		console.log(row("answer correctness", correctness(results), 0.8));

		const unjudged = results.reduce(
			(n, r) => n + (r.judgement?.claimsUnjudged ?? 0),
			0,
		);
		if (unjudged > 0) {
			// Excluded rather than scored zero: a judge that timed out has said
			// nothing about the answer, and counting silence as failure is how a
			// flaky judge gets mistaken for a quality regression.
			console.log(
				`\n  ${unjudged} claim${unjudged === 1 ? "" : "s"} could not be judged and ` +
					"are excluded, not counted as failures.",
			);
		}
		console.log(
			"\n  A model grading a model. PLAN.md pairs this with a weekly human\n" +
				"  spot-check — treat it as a regression signal, not as truth.",
		);
	} else {
		console.log(
			"\n  Two Phase 0 gates need the judge and are not measured here:\n" +
				"  answer correctness (>0.80) and citation faithfulness (>0.95).\n" +
				"  Re-run with --judge.",
		);
	}

	const failed = results.filter((r) => !r.ok);
	if (failed.length > 0) {
		console.log(
			`\n  ${failed.length} quer${failed.length === 1 ? "y" : "ies"} errored.`,
		);
	}

	console.log();
	await pool.end();
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exit(1);
});
