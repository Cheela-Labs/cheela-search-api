import {
	type Classification,
	CONFIDENT,
	INTENTS,
	type Intent,
} from "../../contracts/intent.js";
import type { TextModel } from "../../infra/model/index.js";
import { config } from "../../shared/config.js";
import { logger } from "../../shared/logger.js";

/**
 * The Intent Engine.
 *
 * Classifies before retrieval, because the classification changes what is
 * retrieved and how it is ranked — not after, where it would be a label on a
 * decision already made.
 *
 * Two stages: a structural pass that needs no model, then the model. The
 * structural pass exists because a meaningful share of queries are decidable
 * from their shape alone, and spending a network round trip inside the latency
 * budget to be told that `github.com` is navigational is a waste of the budget
 * and of the money.
 */

/**
 * What the registry recognised, carried alongside the classification.
 *
 * Deliberately not folded into `Classification`. That type is projected onto
 * the wire (`contracts/search.ts`), and an official domain is an internal
 * ranking input rather than something the response promises — putting it there
 * would make an implementation detail part of the API the first time somebody
 * serialised it.
 */
export type Navigation = {
	/** The name recognised, when a name was. A typed hostname resolves no name. */
	entity?: string;
	officialDomain: string;
	/** The homepage, when the registry holds one or the reader typed one. */
	officialUrl?: string;
};

export type ClassifiedQuery = Classification & { navigation?: Navigation };

export type Classifier = (
	query: string,
	signal?: AbortSignal,
) => Promise<ClassifiedQuery>;

/** A bare hostname or URL. `node.js` must not match, hence the extension list. */
const HOSTNAME =
	/^(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?:\/\S*)?$/i;
const FILE_EXTENSION =
	/\.(js|ts|py|rb|go|rs|java|c|cpp|h|json|md|txt|sh|yml|yaml|toml|css|html|jsx|tsx|php)$/i;

export type Structural = {
	intent: Intent;
	url?: string;
	/** Set when a known entity name was recognised. */
	entity?: string;
	officialDomain?: string;
	officialUrl?: string;
} | null;

/**
 * Words that turn a name into a question about the name.
 *
 * "redis" wants redis.io. "redis tutorial" wants whoever explains it best, and
 * "redis wiki" wants Wikipedia — the user named the destination they did not
 * want. Treating those as navigational is worse than not detecting navigation
 * at all, because the official-domain boost is strong enough to bury the thing
 * they asked for.
 *
 * `docs` is here for the same reason and is the least obvious: `redis docs`
 * should land on redis.io/docs, and it does — the official-domain boost applies
 * to the whole domain, and the depth rule picks the docs page. It does not need
 * to be classified navigational to get there, and classifying it so would push
 * the homepage above the docs page the user asked for.
 */
const MODIFIERS = new Set([
	"tutorial",
	"tutorials",
	"wiki",
	"wikipedia",
	"github",
	"docs",
	"doc",
	"documentation",
	"guide",
	"guides",
	"example",
	"examples",
	"vs",
	"versus",
	"alternative",
	"alternatives",
	"review",
	"reviews",
	"news",
	"download",
	"install",
	"error",
	"issue",
	"meaning",
	"define",
	"definition",
]);

const QUESTION_WORDS = new Set([
	"what",
	"who",
	"when",
	"where",
	"why",
	"how",
	"is",
	"are",
	"does",
	"do",
	"can",
	"should",
	"which",
	"will",
]);

/** The brief's rule: a navigational query is short. Three words is the ceiling. */
const MAX_NAVIGATIONAL_WORDS = 3;

export type StructuralDeps = {
	/** Synchronous on purpose — see the registry's own comment. */
	lookup(surface: string): {
		name: string;
		officialDomain: string;
		officialUrl?: string | null;
	} | null;
};

export function classifyStructurally(
	query: string,
	deps?: StructuralDeps,
): Structural {
	const trimmed = query.trim();

	if (!/\s/.test(trimmed)) {
		const match = HOSTNAME.exec(trimmed);
		if (match && !FILE_EXTENSION.test(trimmed)) {
			const url = trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
			// The typed host *is* the official domain for this query. Somebody who
			// types `redis.io` has named their destination more precisely than any
			// registry could, so the ranking layer should treat it exactly as it
			// treats a registry hit — otherwise the one query where the answer is
			// unambiguous is the one where nothing is boosted.
			return {
				intent: "navigation",
				url,
				officialDomain: match[1].toLowerCase(),
				officialUrl: url,
			};
		}
	}

	// A known name, with nothing else asked about it.
	//
	// This used to bail on any whitespace at all, which meant `vercel login`
	// could never reach the structural pass and every entity-name query was left
	// to the model. That is why production classified `vercel` as navigation and
	// `redis` and `stripe` as information: the same question, three different
	// answers, because it was a guess each time.
	if (!deps) return null;

	const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0 || words.length > MAX_NAVIGATIONAL_WORDS) return null;
	if (words.some((word) => MODIFIERS.has(word) || QUESTION_WORDS.has(word))) {
		return null;
	}

	// Longest match first: "hugging face" is one entity, and checking the whole
	// phrase before its words is what stops it resolving to "face".
	for (let length = words.length; length >= 1; length -= 1) {
		const entity = deps.lookup(words.slice(0, length).join(" "));
		if (entity) {
			return {
				intent: "navigation",
				entity: entity.name,
				officialDomain: entity.officialDomain,
				officialUrl: entity.officialUrl ?? undefined,
			};
		}
	}

	return null;
}

const SYSTEM = `You classify a web search query. Reply with exactly three lines and nothing else:

intent: <one of: ${INTENTS.join(" | ")}>
confidence: <0.0 to 1.0, how certain you are>
entities: <comma-separated proper nouns in the query, or NONE>

Guidance:
- "information" is the default. Use it when no other label clearly fits.
- "event" is a specific occurrence in time; "news" is what happened recently.
- "action" means the user wants to DO something, not read about it.
- "navigation" means they want a specific site.
- "comparison" means two or more named things are being weighed.
- Report low confidence honestly. A confident wrong label is worse than an
  uncertain right one, because it changes the ranking.
- entities are the things a knowledge graph would have a node for. Not verbs,
  not common nouns.`;

function parse(text: string): Classification | null {
	const fields = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator === -1) continue;
		fields.set(
			line.slice(0, separator).trim().toLowerCase(),
			line.slice(separator + 1).trim(),
		);
	}

	const rawIntent = fields.get("intent")?.toLowerCase();
	const intent = INTENTS.find((candidate) => candidate === rawIntent);
	if (!intent) return null;

	const confidence = Number(fields.get("confidence"));
	const entities = (fields.get("entities") ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0 && entry.toUpperCase() !== "NONE");

	return {
		intent,
		confidence: Number.isFinite(confidence)
			? Math.min(1, Math.max(0, confidence))
			: 0.5,
		entities: entities.slice(0, 8),
	};
}

/** The answer when there is nothing better. Neutral boosts, neutral decay. */
export const UNCERTAIN: Classification = {
	intent: "information",
	confidence: 0,
	entities: [],
};

export function createClassifier(
	model: TextModel,
	registry?: StructuralDeps,
): Classifier {
	return async (query, signal) => {
		const structural = classifyStructurally(query, registry);
		if (structural) {
			// A hostname is not a guess, and neither is a name we hold an official
			// domain for. Nothing a model says would improve either.
			return {
				intent: structural.intent,
				confidence: 1,
				entities: structural.entity ? [structural.entity] : [],
				// Keyed on the domain alone, not on the domain *and* a name. A
				// typed hostname resolves the most precise destination there is
				// and recognises no entity, so requiring both meant `redis.io`
				// carried no navigation at all — the one query where the answer
				// is unambiguous was the one where nothing was passed on.
				...(structural.officialDomain
					? {
							navigation: {
								entity: structural.entity,
								officialDomain: structural.officialDomain,
								officialUrl: structural.officialUrl,
							},
						}
					: {}),
			};
		}

		try {
			const text = await model.complete({
				system: SYSTEM,
				user: query,
				model: config.INTENT_MODEL,
				maxTokens: 100,
				temperature: 0,
				signal,
			});

			const parsed = parse(text);
			if (!parsed) {
				logger.warn({ text: text.slice(0, 200) }, "unparseable intent reply");
				return UNCERTAIN;
			}
			return parsed;
		} catch (error) {
			// Every failure path returns `information` rather than throwing. The
			// classifier is an optimisation: without it the engine still answers,
			// with neutral ranking. Failing the search because the label was
			// unavailable would trade a good answer for no answer.
			logger.warn(
				{ error: (error as Error).message },
				"intent classification failed",
			);
			return UNCERTAIN;
		}
	};
}

/** True when the classification is firm enough to act on. */
export function actOn(classification: Classification): Intent {
	return classification.confidence >= CONFIDENT
		? classification.intent
		: "information";
}
