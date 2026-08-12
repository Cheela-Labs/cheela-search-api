import { OpenRouterProvider } from "@cheela/provider";
import { config } from "../../shared/config";
import { extractiveComposer } from "./extractive";
import { createLlmComposer } from "./llm";
import type { Composer } from "./types";

export { splitSections, toSpans } from "./citations";
export { extractiveComposer } from "./extractive";
export { createLlmComposer, type LlmComposerOptions } from "./llm";
export {
	type CitedSource,
	type ComposeInput,
	type Composer,
	citationNumbers,
	sourcesFrom,
	swatchFor,
} from "./types";

/**
 * The composer this service uses.
 *
 * Falls back to quoting when no model is configured, rather than refusing the
 * query: every stage before composition still ran, and a page of cited extracts
 * is worth more than an error on a query the retrieval stages answered.
 *
 * The model goes through `@cheela/provider` rather than a vendor SDK, because
 * routing, reranking and composition have genuinely different cost and latency
 * profiles and each will want a different model pinned — which is a decision to
 * keep changeable rather than to embed in an import.
 */
export const composer: Composer = config.COMPOSER_API_KEY
	? createLlmComposer({
			provider: new OpenRouterProvider({
				apiKey: config.COMPOSER_API_KEY,
				model: config.COMPOSER_MODEL,
			}),
		})
	: extractiveComposer;
