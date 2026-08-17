import { z } from "zod";

/**
 * The intent taxonomy, exactly as both specification documents list it.
 *
 * Twenty values is a lot for a classifier to be reliable at, and that is a
 * known cost rather than an oversight: the taxonomy is the specification's,
 * and collapsing it here would silently change the contract every other
 * component is written against. What the code does instead is treat low
 * confidence as its own outcome — see `Classification.confidence` — so a
 * fifty-fifty call between `news` and `event` degrades to a neutral ranking
 * rather than to a confident wrong one.
 */
export const INTENTS = [
	"information",
	"event",
	"shopping",
	"documentation",
	"navigation",
	"action",
	"local",
	"news",
	"comparison",
	"image",
	"video",
	"research",
	"finance",
	"health",
	"travel",
	"sports",
	"entertainment",
	"education",
	"coding",
	"utility",
] as const;

export type Intent = (typeof INTENTS)[number];

export const intentSchema = z.enum(INTENTS);

export type Classification = {
	intent: Intent;
	/** 0..1. Below `CONFIDENT`, callers must not act on the intent. */
	confidence: number;
	/** Entity surface forms the classifier spotted, for the graph to link. */
	entities: string[];
};

/**
 * The line below which an intent is a guess rather than a finding.
 *
 * Ranking multiplies by an intent-derived boost, so a wrong intent held
 * confidently is worse than no intent at all: it actively reorders results
 * away from what was asked. Under this threshold callers fall back to
 * `information`, whose boosts are all neutral.
 */
export const CONFIDENT = 0.55;

/** Whether this intent's answer is a *place to go* rather than a thing to read. */
export function isDestinationIntent(intent: Intent): boolean {
	return (
		intent === "navigation" ||
		intent === "shopping" ||
		intent === "local" ||
		intent === "travel"
	);
}

/**
 * How fast this kind of question goes stale, in seconds, as a half-life.
 *
 * Fed to Vespa as `query(freshness_halflife)`. This is the concrete thing the
 * intent engine buys: the same corpus, ranked differently, because "news
 * about X" and "how does X work" disagree about whether a 2019 page is good.
 */
export function freshnessHalfLife(intent: Intent): number {
	const DAY = 86_400;
	switch (intent) {
		case "news":
			return 2 * DAY;
		case "sports":
		case "finance":
			return 7 * DAY;
		case "event":
		case "shopping":
		case "travel":
		case "local":
			return 90 * DAY;
		case "documentation":
		case "coding":
		case "education":
		case "research":
			// Deliberately long. A 2015 answer about a stable API is usually
			// still the right answer, and punishing it for its date is how
			// documentation search gets worse than the vendor's own site.
			return 3 * 365 * DAY;
		default:
			return 365 * DAY;
	}
}

/**
 * The TDS's `IntentBoost`, the multiplier outside the sum.
 *
 * It is 1.0 for almost everything on purpose. The multiplier's job is to say
 * "this whole class of result is more or less appropriate to this question" —
 * it is not a second relevance signal, and using it as one double-counts
 * whatever the terms inside the sum already measured.
 */
export function intentBoost(intent: Intent, kind: "document" | "capability") {
	if (kind === "capability") {
		// An action query wants a button, not an essay. This is the one place
		// the multiplier earns a large number.
		if (intent === "action" || intent === "utility") return 2.5;
		if (intent === "shopping" || intent === "travel") return 1.4;
		// Elsewhere a capability may still be the best hit, but it has to win
		// on its own terms rather than on its type.
		return 0.8;
	}

	if (intent === "action" || intent === "utility") return 0.7;
	return 1.0;
}
