import type { Classification, Intent } from "../../contracts/intent.js";
import type { TextModel } from "../../infra/model/index.js";
import { config } from "../../shared/config.js";
import { logger } from "../../shared/logger.js";

export {
	type Fused,
	type FusionInput,
	reciprocalRankFusion,
} from "./rrf.js";

/**
 * The Query Evolution Engine.
 *
 * Instead of issuing one search, Cheela generates several retrieval
 * hypotheses and fuses their results. "PS5" becomes "PlayStation 5 reviews",
 * "PlayStation 5 price", "Buy PlayStation 5", "Sony PlayStation 5"; a short
 * query that means four things is searched as four things.
 *
 * The sources, in the order they are trusted:
 *
 * 1. **Query memory** — expansions that have been asked before and got a
 *    click. An expansion with evidence beats one a model invented.
 * 2. **Knowledge graph aliases** — "PS5" is an alias, and the alias is the
 *    form the query used precisely because it is the short one.
 * 3. **The model** — for everything the first two do not cover.
 *
 * The original query is always hypothesis zero and always carries the highest
 * fusion weight. Expansion adds recall; it must never be able to lose the
 * thing the user actually typed.
 */

export type Hypothesis = {
	query: string;
	/** Fusion weight. The original is 1; expansions are worth less. */
	weight: number;
	source: "original" | "memory" | "alias" | "model";
};

export type EvolutionDeps = {
	model: TextModel;
	/** Expansions previously recorded for this query, best first. */
	remembered?: (query: string) => Promise<string[]>;
	/** Aliases for the entities the classifier spotted. */
	aliases?: (entities: string[]) => Promise<string[]>;
};

/**
 * Queries that are already specific gain nothing from expansion and lose
 * latency to it. A long natural-language question has already said what it
 * means; a two-word product name has not.
 */
export function worthExpanding(query: string, intent: Intent): boolean {
	if (intent === "navigation") return false;
	const words = query.trim().split(/\s+/).length;
	return words <= 6;
}

const SYSTEM = `You expand a short, ambiguous search query into distinct retrieval hypotheses.

Reply with one hypothesis per line and nothing else. No numbering, no commentary.

Rules:
- Each line must be a different INTERPRETATION, not a rephrasing. "PS5 price"
  and "cost of PS5" are the same hypothesis and you should give only one.
- Expand abbreviations and short names to their full form on at least one line.
- Do not invent facts. If the query names a year, a place or a product, do not
  change it to a different year, place or product.
- Never output more than 4 lines. Fewer is fine, and one is fine when the query
  is already unambiguous.`;

/**
 * Removes the list markers the model adds despite being told not to.
 *
 * Narrow on purpose. A greedier version of this — one character class of
 * `-*\d.)` repeated — turns "2019-20 Australian bushfire season" into
 * "Australian bushfire season", because the year looks exactly like an
 * enumerator. A stripper that silently deletes the most specific part of a
 * query is worse than one that occasionally leaves a bullet in.
 */
function clean(line: string): string {
	return line
		.replace(/^\s*(?:[-*•]\s+|\d{1,2}[.)]\s+)/, "")
		.replace(/^["']|["']$/g, "")
		.trim();
}

export function createEvolution(deps: EvolutionDeps) {
	return {
		async expand(
			query: string,
			classification: Classification,
			signal?: AbortSignal,
		): Promise<Hypothesis[]> {
			const original: Hypothesis = {
				query,
				weight: 1,
				source: "original",
			};

			if (!worthExpanding(query, classification.intent)) return [original];

			const seen = new Set([query.toLowerCase()]);
			const hypotheses: Hypothesis[] = [original];
			const budget = Math.max(1, config.MAX_HYPOTHESES);

			const add = (
				text: string,
				weight: number,
				source: Hypothesis["source"],
			) => {
				const candidate = clean(text);
				const key = candidate.toLowerCase();
				if (!candidate || seen.has(key) || candidate.length > 200) return;
				if (hypotheses.length >= budget) return;
				seen.add(key);
				hypotheses.push({ query: candidate, weight, source });
			};

			// Memory and aliases run concurrently and neither may fail the query:
			// they are both "nice to have" evidence, and a graph outage should
			// cost recall, not the search.
			const [remembered, aliases] = await Promise.all([
				deps.remembered?.(query).catch(() => []) ?? [],
				deps.aliases?.(classification.entities).catch(() => []) ?? [],
			]);

			for (const entry of remembered) add(entry, 0.9, "memory");
			for (const entry of aliases) add(entry, 0.8, "alias");

			if (hypotheses.length < budget) {
				try {
					const text = await deps.model.complete({
						system: SYSTEM,
						user: `Query: ${query}\nIntent: ${classification.intent}`,
						model: config.EVOLUTION_MODEL,
						maxTokens: 120,
						temperature: 0.3,
						signal,
					});
					for (const line of text.split(/\r?\n/)) add(line, 0.7, "model");
				} catch (error) {
					logger.warn(
						{ error: (error as Error).message },
						"query expansion failed; searching the original only",
					);
				}
			}

			return hypotheses;
		},
	};
}

export type Evolution = ReturnType<typeof createEvolution>;
