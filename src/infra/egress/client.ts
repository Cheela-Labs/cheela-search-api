import type { LookupAddress } from "node:dns";
import { promises as dns, type lookup as dnsLookup } from "node:dns";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { Agent, request as undiciRequest } from "undici";
import { type AddressVerdict, classifyAddress } from "./addresses.js";
import { EgressError } from "./errors.js";
import { allowAll, type RobotsPolicy } from "./robots.js";

/**
 * The one way this service talks to the internet.
 *
 * Everything outbound goes through here — page fetches, provider APIs, model
 * calls, manifest probes — so that there is exactly one place where the
 * outbound policy lives and exactly one place to audit. A second path that
 * "just needs a quick fetch" is the path that will not have these checks.
 *
 * ## The policy
 *
 * 1. http and https only, on ports 80 and 443 only.
 * 2. Every address the hostname resolves to must be a public unicast address.
 *    *Every* one, not the first: a hostname that resolves to one public and
 *    one private address is an attack, not a multi-homed server.
 * 3. The connection is pinned to a pre-validated address, so nothing can
 *    change between the check and the connect. This is the DNS-rebinding
 *    defence and it is the reason the lookup is overridden rather than the
 *    address merely inspected.
 * 4. Redirects are followed manually, same-host only, and counted.
 * 5. A whole-request deadline, a response byte cap enforced while streaming,
 *    and a decompressed-output cap.
 * 6. robots.txt is consulted for page fetches.
 */

export type EgressConfig = {
	timeoutMs: number;
	maxBytes: number;
	maxRedirects: number;
	userAgent: string;
	respectRobots: boolean;
};

export type EgressRequest = {
	method?: "GET" | "POST";
	headers?: Record<string, string>;
	body?: string;
	/**
	 * Page fetches are crawling and must obey robots.txt. Calls to an API we
	 * hold a key for are not crawling — nobody's robots.txt is a statement
	 * about our own API credentials — so this defaults to false and the
	 * fetcher opts in.
	 */
	crawl?: boolean;
	signal?: AbortSignal;
};

export type EgressResponse = {
	/** After redirects, when there were any. */
	url: string;
	status: number;
	headers: Record<string, string>;
	body: Buffer;
};

export type EgressDeps = {
	/** Overridden in tests so fixture servers on 127.0.0.1 are reachable. */
	classify?: (address: string) => AddressVerdict;
	allowPort?: (port: number) => boolean;
	robots?: RobotsPolicy;
};

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
const DEFAULT_PORTS: Record<string, number> = { "http:": 80, "https:": 443 };

export function createEgressClient(
	settings: EgressConfig,
	deps: EgressDeps = {},
) {
	const classify = deps.classify ?? classifyAddress;
	const allowPort =
		deps.allowPort ?? ((port: number) => port === 80 || port === 443);
	const robots = deps.robots ?? allowAll;

	/**
	 * Resolves a hostname and refuses unless every answer is publicly
	 * routable, returning the addresses so the connection can be pinned to
	 * them.
	 */
	async function resolvePinned(
		hostname: string,
		url: string,
	): Promise<LookupAddress[]> {
		// A literal address in the URL never reaches a resolver, so check it
		// directly rather than trusting the lookup to echo it back.
		const literal = classify(hostname.replace(/^\[|\]$/g, ""));
		if (!literal.allowed && literal.reason !== "unparseable") {
			throw new EgressError("blocked-address", url, literal.reason);
		}

		let addresses: LookupAddress[];
		try {
			addresses = await dns.lookup(hostname, { all: true, verbatim: true });
		} catch (error) {
			throw new EgressError(
				"dns-failure",
				url,
				error instanceof Error ? error.message : String(error),
			);
		}

		if (addresses.length === 0) {
			throw new EgressError("dns-failure", url, "no addresses");
		}

		for (const entry of addresses) {
			const verdict = classify(entry.address);
			if (!verdict.allowed) {
				throw new EgressError("blocked-address", url, verdict.reason);
			}
		}

		return addresses;
	}

	/**
	 * A lookup that ignores the resolver and returns the addresses we already
	 * validated. This is what closes the check-then-connect window: undici
	 * cannot be handed an address that was not classified.
	 */
	function pinnedLookup(addresses: LookupAddress[]): typeof dnsLookup {
		return ((
			_hostname: string,
			options: unknown,
			callback: (
				error: NodeJS.ErrnoException | null,
				address: string | LookupAddress[],
				family?: number,
			) => void,
		) => {
			const wantsAll =
				typeof options === "object" && options !== null && "all" in options
					? Boolean((options as { all?: boolean }).all)
					: false;
			if (wantsAll) {
				callback(null, addresses);
				return;
			}
			callback(null, addresses[0].address, addresses[0].family);
		}) as unknown as typeof dnsLookup;
	}

	function decode(buffer: Buffer, encoding: string, url: string): Buffer {
		const scheme = encoding.trim().toLowerCase();
		if (!scheme || scheme === "identity") return buffer;

		// maxOutputLength is the zip-bomb guard: a 2MB response that expands to
		// 10GB is a denial of service against this process, and the byte cap on
		// the wire cannot see it.
		const options = { maxOutputLength: settings.maxBytes };
		try {
			if (scheme === "gzip" || scheme === "x-gzip") {
				return gunzipSync(buffer, options);
			}
			if (scheme === "deflate") return inflateSync(buffer, options);
			if (scheme === "br") return brotliDecompressSync(buffer, options);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Node reports the cap as ERR_BUFFER_TOO_LARGE, a RangeError, rather
			// than as a zlib error. Matched on the code and not the message: the
			// first version of this tested the message, which reads "Cannot
			// create a Buffer larger than N bytes" and does not contain the words
			// that regex was looking for — so a decompression bomb was correctly
			// refused under entirely the wrong reason.
			if (
				typeof error === "object" &&
				error !== null &&
				(error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE"
			) {
				throw new EgressError("response-too-large", url, "decompressed");
			}
			throw new EgressError("decode-failed", url, message);
		}
		// An encoding we do not speak. Returning the compressed bytes would
		// hand the extractor binary and let it report "not HTML".
		throw new EgressError(
			"decode-failed",
			url,
			`unsupported encoding ${scheme}`,
		);
	}

	async function once(
		target: URL,
		options: EgressRequest,
		deadline: number,
		signal: AbortSignal,
	): Promise<EgressResponse> {
		const url = target.toString();

		if (!ALLOWED_SCHEMES.has(target.protocol)) {
			throw new EgressError("scheme-not-allowed", url, target.protocol);
		}
		const port = target.port
			? Number(target.port)
			: DEFAULT_PORTS[target.protocol];
		if (!allowPort(port)) {
			// A public host serving on 6379 is still Redis.
			throw new EgressError("port-not-allowed", url, String(port));
		}

		const addresses = await resolvePinned(target.hostname, url);

		const agent = new Agent({
			connect: { lookup: pinnedLookup(addresses) },
			headersTimeout: Math.max(1, deadline - Date.now()),
			bodyTimeout: Math.max(1, deadline - Date.now()),
		});

		try {
			const response = await undiciRequest(url, {
				method: options.method ?? "GET",
				dispatcher: agent,
				signal,
				// No redirect interceptor is installed on the agent, so undici
				// returns the 3xx and we follow it by hand below. That is
				// deliberate: undici's redirect handling would happily cross to
				// another host, and a redirect to a host we never resolved is
				// precisely what the address check exists to prevent.
				headers: {
					"accept-encoding": "gzip, deflate, br",
					...options.headers,
					// Last, so it cannot be overridden. Written above the spread
					// first, where the caller's headers won and a fetcher could
					// quietly stop identifying itself — which is the one header a
					// crawler does not get to have an opinion about.
					"user-agent": settings.userAgent,
				},
				body: options.body,
			});

			const declared = response.headers["content-length"];
			if (
				typeof declared === "string" &&
				Number(declared) > settings.maxBytes
			) {
				response.body.destroy();
				throw new EgressError(
					"response-too-large",
					url,
					`declared ${declared}`,
				);
			}

			const chunks: Buffer[] = [];
			let total = 0;
			for await (const chunk of response.body) {
				const buffer = Buffer.from(chunk);
				total += buffer.length;
				if (total > settings.maxBytes) {
					response.body.destroy();
					throw new EgressError("response-too-large", url, `streamed ${total}`);
				}
				chunks.push(buffer);
			}

			const headers: Record<string, string> = {};
			for (const [key, value] of Object.entries(response.headers)) {
				headers[key] = Array.isArray(value)
					? value.join(", ")
					: String(value ?? "");
			}

			return {
				url,
				status: response.statusCode,
				headers,
				body: decode(
					Buffer.concat(chunks),
					headers["content-encoding"] ?? "",
					url,
				),
			};
		} finally {
			void agent.close().catch(() => {});
		}
	}

	async function perform(
		rawUrl: string,
		options: EgressRequest = {},
	): Promise<EgressResponse> {
		let target: URL;
		try {
			target = new URL(rawUrl);
		} catch {
			throw new EgressError("invalid-url", rawUrl);
		}

		if (options.crawl && settings.respectRobots) {
			const permitted = await robots.allows(target, settings.userAgent);
			if (!permitted) {
				throw new EgressError("robots-disallowed", target.toString());
			}
		}

		// One deadline for the whole thing, redirects included. A per-hop
		// timeout multiplies by the redirect limit, and four ten-second hops is
		// forty seconds spent on one dead link.
		const deadline = Date.now() + settings.timeoutMs;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
		const onAbort = () => controller.abort();
		options.signal?.addEventListener("abort", onAbort, { once: true });

		try {
			let current = target;
			for (let hop = 0; hop <= settings.maxRedirects; hop += 1) {
				const response = await once(
					current,
					options,
					deadline,
					controller.signal,
				);

				const location = response.headers.location;
				const redirecting =
					response.status >= 300 && response.status < 400 && location;
				if (!redirecting) return response;

				let next: URL;
				try {
					next = new URL(location, current);
				} catch {
					throw new EgressError("invalid-url", location);
				}
				// Same host only. A redirect is a server telling us where to go
				// next, and "go to 169.254.169.254" is a sentence it is allowed to
				// say — the address check would catch that one, but same-host is
				// the rule that does not depend on catching each case.
				if (next.hostname !== current.hostname) {
					throw new EgressError("cross-host-redirect", next.toString());
				}
				current = next;
			}
			throw new EgressError("too-many-redirects", current.toString());
		} catch (error) {
			if (error instanceof EgressError) throw error;
			if (controller.signal.aborted) {
				throw new EgressError("timeout", rawUrl);
			}
			throw new EgressError(
				"request-failed",
				rawUrl,
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		}
	}

	return {
		fetch: perform,
		/** For robots.txt itself, which cannot consult robots.txt. */
		fetchRaw: (url: string, options: EgressRequest = {}) =>
			perform(url, { ...options, crawl: false }),
	};
}

export type EgressClient = ReturnType<typeof createEgressClient>;
