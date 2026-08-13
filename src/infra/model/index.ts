import { config } from "../../shared/config";
import { egress } from "../egress";
import { createOpenRouterModel } from "./openrouter";
import type { TextModel } from "./types";

export { createOpenRouterModel } from "./openrouter";
export { type CompletionRequest, ModelError, type TextModel } from "./types";

/**
 * The composer's model, or null when none is configured — in which case the
 * service composes by quoting, which is a worse answer and an honest one.
 */
export const textModel: TextModel | null = config.COMPOSER_API_KEY
	? createOpenRouterModel(
			config.COMPOSER_API_KEY,
			config.COMPOSER_MODEL,
			egress,
		)
	: null;
