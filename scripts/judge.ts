import type { TextModel } from "../src/infra/model";
import type { AnswerBlock, Source, Span } from "../src/shared/events";

/**
 * The LLM judge, for the two Phase 0 gates that need one: answer correctness
 * (>0.80) and citation faithfulness (>0.95).
 *
 * ## It grades claims, not answers
 *
 * Faithfulness is defined in PLAN.md as *"does the cited passage support the
 * claim"* — which is a question about one sentence and one source, not about a
 * paragraph. Asking a model to score a whole answer produces a number that
 * moves when the answer gets longer, and cannot say which sentence was wrong.
 * So the answer is split at its citations and each cited claim is judged
 * against the source it cites.
 *
 * ## It sees the source, not the page
 *
 * The judge is given the title, domain and URL of the cited source — not the
 * passage text, which the harness no longer holds by the time blocks arrive.
 * That is a real limitation and it bounds what this measures: it catches a
 * claim attributed to a source that plainly cannot support it, and it will
 * miss a plausible-looking misattribution. Named here rather than discovered
 * later, and the reason PLAN.md pairs the judge with a human spot-check.
 *
 * ## A failed judgement is not a zero
 *
 * A model that times out has said nothing about the answer. Scoring that as 0
 * would let a flaky judge look like a quality regression — the one confusion
 * this whole harness exists to prevent. Unjudged claims are excluded and
 * counted separately.
 */

export type Judgement = {
	/** 0–1 over judged claims. Null when nothing could be judged. */
	faithfulness: number | null;
	/** 0–1. Null when the query carries no answer to grade. */
	correctness: number | null;
	claimsJudged: number;
	claimsUnjudged: number;
};

const FAITHFULNESS_SYSTEM = `You grade whether a claim could plausibly be supported by a named web source.

You are given ONE claim and the source it cites (title, domain, URL).
Answer with a single word:

SUPPORTED   — the source is plainly the kind of page that would carry this claim
UNSUPPORTED — the source could not carry this claim, or is about something else
UNCLEAR     — you cannot tell from the title and domain alone

Answer with exactly one of those words and nothing else.`;

const CORRECTNESS_SYSTEM = `You grade a search answer for correctness.

You are given a query and the answer produced for it. Judge only whether the
answer is factually right and actually addresses the query. Ignore style,
length, and formatting.

Reply with a single integer from 0 to 10 and nothing else, where:
  10 — correct and directly answers the query
   5 — partially correct, or answers a related question
   0 — wrong, or does not address the query`;

function spansOf(block: AnswerBlock): Span[] {
	return "spans" in block ? block.spans : [];
}

/**
 * Claims paired with the source each cites.
 *
 * A claim is the run of text immediately preceding a citation — which is how
 * the composer is prompted to write, and how the surface renders it. Text
 * carrying no citation is not judged for faithfulness, because there is
 * nothing to be faithful to; it counts against correctness instead.
 */
export function citedClaims(
	blocks: AnswerBlock[],
	sources: Source[],
): { claim: string; source: Source }[] {
	const byNumber = new Map(sources.map((source) => [source.n, source]));
	const pairs: { claim: string; source: Source }[] = [];

	for (const block of blocks) {
		let pending = "";
		for (const span of spansOf(block)) {
			if (span.kind === "text") {
				pending += span.text;
				continue;
			}
			const source = byNumber.get(span.n);
			const claim = pending.trim();
			// An invented citation number resolves to nothing. `citationValidity`
			// in the harness counts those; judging them would double-count one
			// defect as two.
			if (source && claim.length > 0) pairs.push({ claim, source });
		}
	}
	return pairs;
}

async function judgeClaim(
	model: TextModel,
	claim: string,
	source: Source,
): Promise<"supported" | "unsupported" | null> {
	try {
		const reply = await model.complete({
			system: FAITHFULNESS_SYSTEM,
			user: `Claim: ${claim}\n\nSource title: ${source.title}\nSource domain: ${source.domain}\nSource URL: ${source.url}`,
		});
		const word = reply.trim().toUpperCase();
		if (word.startsWith("SUPPORTED")) return "supported";
		if (word.startsWith("UNSUPPORTED")) return "unsupported";
		// UNCLEAR, or anything unparseable, is not a verdict.
		return null;
	} catch {
		return null;
	}
}

async function judgeCorrectness(
	model: TextModel,
	query: string,
	answer: string,
): Promise<number | null> {
	try {
		const reply = await model.complete({
			system: CORRECTNESS_SYSTEM,
			user: `Query: ${query}\n\nAnswer: ${answer}`,
		});
		const score = Number.parseInt(reply.trim().match(/\d+/)?.[0] ?? "", 10);
		if (!Number.isFinite(score) || score < 0 || score > 10) return null;
		return score / 10;
	} catch {
		return null;
	}
}

export async function judge(
	model: TextModel,
	query: string,
	blocks: AnswerBlock[],
	sources: Source[],
	answerText: string,
): Promise<Judgement> {
	const claims = citedClaims(blocks, sources);

	let supported = 0;
	let judged = 0;
	let unjudged = 0;

	for (const { claim, source } of claims) {
		const verdict = await judgeClaim(model, claim, source);
		if (verdict === null) {
			unjudged += 1;
			continue;
		}
		judged += 1;
		if (verdict === "supported") supported += 1;
	}

	const correctness = answerText.trim()
		? await judgeCorrectness(model, query, answerText)
		: null;

	return {
		faithfulness: judged === 0 ? null : supported / judged,
		correctness,
		claimsJudged: judged,
		claimsUnjudged: unjudged,
	};
}
