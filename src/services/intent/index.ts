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

export type Classifier = (
	query: string,
	signal?: AbortSignal,
) => Promise<Classification>;

/** A bare hostname or URL. `node.js` must not match, hence the extension list. */
const HOSTNAME =
	/^(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?:\/\S*)?$/i;
const FILE_EXTENSION =
	/\.(js|ts|py|rb|go|rs|java|c|cpp|h|json|md|txt|sh|yml|yaml|toml|css|html|jsx|tsx|php)$/i;

export type Structural = { intent: Intent; url?: string } | null;

export function classifyStructurally(query: string): Structural {
	const trimmed = query.trim();
	if (/\s/.test(trimmed)) return null;

	const match = HOSTNAME.exec(trimmed);
	if (match && !FILE_EXTENSION.test(trimmed)) {
		const url = trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
		return { intent: "navigation", url };
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

export function createClassifier(model: TextModel): Classifier {
	return async (query, signal) => {
		const structural = classifyStructurally(query);
		if (structural) {
			// A hostname is not a guess. Nothing a model says would improve it.
			return { intent: structural.intent, confidence: 1, entities: [] };
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
