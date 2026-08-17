import { config } from "../../shared/config.js";
import type { EgressClient } from "../egress/client.js";
import { egress } from "../egress/index.js";

/**
 * The text model client.
 *
 * One interface, three callers with different budgets: the intent classifier
 * and the evolution engine run *before* retrieval and are inside the latency
 * budget, so they get a small model and a short deadline; the generator runs
 * after and gets the larger one.
 *
 * Requests carry no `tools` key, and that is structural rather than
 * incidental. Everything these prompts read — page text, titles, snippets — is
 * attacker-influenceable, so a model that could call a tool would be a model
 * an indexed page could instruct. There is no tool to call, so a successful
 * prompt injection can at worst produce bad text.
 */

export type CompletionRequest = {
	system: string;
	user: string;
	model: string;
	maxTokens?: number;
	temperature?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
};

export class ModelError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelError";
	}
}

export type TextModel = {
	complete(request: CompletionRequest): Promise<string>;
};

export function createModel(
	apiKey: string,
	client: EgressClient,
	endpoint: string = config.MODEL_ENDPOINT,
): TextModel {
	return {
		async complete(request: CompletionRequest): Promise<string> {
			const response = await client.fetch(endpoint, {
				method: "POST",
				signal: request.signal,
				headers: {
					authorization: `Bearer ${apiKey}`,
					"content-type": "application/json",
					// OpenRouter attribution. Not required, but a request without
					// it is rate-limited more aggressively.
					"http-referer": "https://search.cheelalabs.com",
					"x-title": "Cheela Search",
				},
				body: JSON.stringify({
					model: request.model,
					temperature: request.temperature ?? 0.2,
					max_tokens: request.maxTokens ?? 900,
					messages: [
						{ role: "system", content: request.system },
						{ role: "user", content: request.user },
					],
				}),
			});

			if (response.status >= 400) {
				throw new ModelError(
					`model ${response.status}: ${response.body.toString("utf8").slice(0, 300)}`,
				);
			}

			let parsed: {
				choices?: { message?: { content?: string } }[];
				error?: { message?: string };
			};
			try {
				parsed = JSON.parse(response.body.toString("utf8"));
			} catch {
				throw new ModelError("model returned a body that is not JSON");
			}

			if (parsed.error) {
				throw new ModelError(parsed.error.message ?? "model reported an error");
			}
			const content = parsed.choices?.[0]?.message?.content;
			if (typeof content !== "string") {
				throw new ModelError("model returned no content");
			}
			return content;
		},
	};
}

export const model: TextModel = createModel(config.MODEL_API_KEY, egress);
