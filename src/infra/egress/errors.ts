/**
 * Why a fetch was refused.
 *
 * A discriminant rather than a message, because callers act on these
 * differently — `blocked-address` is a security event worth counting, `timeout`
 * is a page to drop and move on from, and `response-too-large` may mean the
 * cap is wrong. Tests assert on the reason for the same purpose: an assertion
 * on message text passes for the wrong cause the moment somebody rewords it.
 */
export type EgressRefusal =
	| "invalid-url"
	| "scheme-not-allowed"
	| "port-not-allowed"
	| "dns-failure"
	| "blocked-address"
	| "cross-host-redirect"
	| "too-many-redirects"
	| "response-too-large"
	/** Advertised an encoding it then did not send, or sent a corrupt one. */
	| "decode-failed"
	| "timeout"
	| "request-failed";

export class EgressError extends Error {
	readonly reason: EgressRefusal;
	readonly url: string;

	constructor(reason: EgressRefusal, url: string, detail: string) {
		super(`${reason}: ${detail}`);
		this.name = "EgressError";
		this.reason = reason;
		this.url = url;
	}
}

export const isEgressError = (error: unknown): error is EgressError =>
	error instanceof EgressError;
