/**
 * Why an outbound request did not happen, or did not finish.
 *
 * Every one of these is an ordinary outcome rather than a bug: the web refuses,
 * redirects, hangs and lies, and a fetcher that throws on any of that is a
 * fetcher whose caller has to catch everything anyway. The reason is a closed
 * set so the caller can branch on it and so a metric can count it.
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
	| "decode-failed"
	| "robots-disallowed"
	| "timeout"
	| "request-failed";

export class EgressError extends Error {
	readonly reason: EgressRefusal;
	readonly url: string;

	constructor(reason: EgressRefusal, url: string, detail?: string) {
		super(detail ? `${reason}: ${detail} (${url})` : `${reason} (${url})`);
		this.name = "EgressError";
		this.reason = reason;
		this.url = url;
	}
}

export function isEgressError(error: unknown): error is EgressError {
	return error instanceof EgressError;
}
