/**
 * A text completion, and nothing else.
 *
 * ## Why this exists instead of `@cheela/provider`
 *
 * PLAN.md said the LLM stages would go through `@cheela/provider`, and that was
 * wrong for this one. Every provider in that package calls
 * `assertHasCapabilities`, which refuses a request carrying no tools — for a
 * good reason, documented there: an agent runtime with an empty tool list is a
 * plain chat completion wearing an assistant's clothes, and it fails silently.
 *
 * Composition is not an agent runtime. **The composer has no tools on purpose**
 * — it is the structural half of the injection containment, and a test asserts
 * the request carries no capabilities. Registering a dummy capability to satisfy
 * the assertion would hand a model reading untrusted page content something to
 * call, which is the exact thing the design forbids.
 *
 * So the abstraction the plan actually wanted — a seam that lets a different
 * model be pinned per stage, and changed later — is kept, and it lives here
 * where it can be one method wide.
 *
 * ## The call goes through the egress client
 *
 * A consequence worth having rather than a compromise. "One client, one policy"
 * holds: the model call gets the same wall-clock deadline, the same response
 * size cap, and the same address rules as a page fetch. A vendor having a bad
 * afternoon costs a query rather than a worker.
 */

export type CompletionRequest = {
	system: string;
	user: string;
	signal?: AbortSignal;
};

export type TextModel = {
	/** Identifier for logs and for the eval harness to attribute a run. */
	readonly name: string;
	complete(request: CompletionRequest): Promise<string>;
};

/** Raised when the model could not be reached or answered unusably. */
export class ModelError extends Error {
	readonly model: string;

	constructor(model: string, detail: string) {
		super(`${model}: ${detail}`);
		this.name = "ModelError";
		this.model = model;
	}
}
