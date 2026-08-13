import type { EgressClient } from "../egress/client";
import { type CompletionRequest, ModelError, type TextModel } from "./types";

/**
 * OpenRouter, over the egress client.
 *
 * One endpoint, no tools, no streaming. The composer yields blocks as it parses
 * labelled sections, and streaming tokens would only let it yield the *first*
 * block sooner — worth having eventually, and not worth a partial-parse state
 * machine before the eval harness can say whether the answers are any good.
 *
 * Shape verified against a live call before this was written, the same
 * discipline the AnySearch provider follows and for the same reason.
 */

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

type ChatResponse = {
	choices?: { message?: { content?: unknown } }[];
	error?: { message?: unknown };
};

export function createOpenRouterModel(
	apiKey: string,
	model: string,
	client: EgressClient,
	endpoint: string = ENDPOINT,
): TextModel {
	return {
		name: model,

		async complete(request: CompletionRequest): Promise<string> {
			let response: Awaited<ReturnType<EgressClient["fetch"]>>;
			try {
				response = await client.fetch(endpoint, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${apiKey}`,
						accept: "application/json",
						// OpenRouter attributes traffic by these and they cost nothing.
						// A vendor that can see who is calling can talk to us before
						// rate-limiting us.
						"http-referer": "https://search.cheelalabs.com",
						"x-title": "Cheela Search",
					},
					body: JSON.stringify({
						model,
						messages: [
							{ role: "system", content: request.system },
							{ role: "user", content: request.user },
						],
						// No `tools` key at all. Its absence is the containment: a model
						// reading untrusted page content has nothing it could call.
						temperature: 0.2,
						max_tokens: 900,
					}),
				});
			} catch (error) {
				throw new ModelError(
					model,
					error instanceof Error ? error.message : String(error),
				);
			}

			let payload: ChatResponse;
			try {
				payload = JSON.parse(response.body.toString("utf8")) as ChatResponse;
			} catch {
				throw new ModelError(
					model,
					`HTTP ${response.status}, body was not JSON`,
				);
			}

			if (response.status !== 200) {
				const detail =
					typeof payload.error?.message === "string"
						? payload.error.message
						: `HTTP ${response.status}`;
				throw new ModelError(model, detail);
			}

			const content = payload.choices?.[0]?.message?.content;
			if (typeof content !== "string") {
				// An empty or reshaped response is a changed contract, not an empty
				// answer — conflating them would let a broken integration read as a
				// question nobody could answer.
				throw new ModelError(
					model,
					"response had no choices[0].message.content string",
				);
			}

			return content;
		},
	};
}
