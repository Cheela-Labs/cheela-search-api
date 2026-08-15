import { readFile } from "node:fs/promises";
import { composer } from "../src/domain/compose";
import { runPipeline } from "../src/domain/pipeline";
import type { RetrievalStats } from "../src/domain/retrieval/fetch";
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
 * Did the queries labelled unanswerable stay quiet.
 *
 * The one metric where a *high* answer rate is the failure. A search engine
 * that always produces a confident paragraph is not answering; it is
 * generating, and this is the only check in the set that can tell.
 */
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
	console.log(row("extraction rate", extractionRate(results), 0.9));
	console.log(row("domain recall", domainRecall(results)));
	console.log(row("citation validity", citationValidity(results), 1));
	console.log(row("must-mention", mentionRate(results)));
	console.log(row("restraint on empty", restraint(results)));

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
