import { lookup as dnsLookup } from "node:dns/promises";
import type { Readable } from "node:stream";
import { Agent, request } from "undici";
import { type AddressVerdict, classifyAddress } from "./addresses";
import { EgressError } from "./errors";

/**
 * The one outbound HTTP client. Every fetch this service makes goes through
 * it, in both planes.
 *
 * "One client, one policy" is the whole design. Two implementations means one
 * of them is wrong, and the wrong one is whichever was written second by
 * somebody who did not know the first existed. So this is deliberately the
 * only module that imports `undici`, and page fetching, manifest fetching and
 * capability invocation are all callers rather than variants.
 *
 * ## What it defends against
 *
 * Both planes fetch URLs an attacker influences — result URLs from an index
 * that can be SEO-manipulated, and `endpoint.address` out of manifests written
 * by strangers. On Cloud Run the worst case is credential theft via the
 * metadata server, so:
 *
 * - **Resolve first, judge the addresses, then pin.** The hostname is resolved
 *   once. Every address it returns is classified, and the connection is made to
 *   an address that was actually checked — not to whatever a second lookup
 *   would return. Without the pin there is a window between the check and the
 *   connect in which DNS can change its mind, and that window is the whole of
 *   the DNS-rebinding attack.
 * - **Reject the hostname if *any* resolved address is blocked.** Not "filter
 *   to the good ones": a name that resolves to both a public address and
 *   127.0.0.1 is not a name we have any business fetching, and picking the
 *   survivor would make the outcome depend on resolver ordering.
 * - **Redirects are followed manually, never by undici**, and only within the
 *   same host. Automatic following re-resolves and re-connects outside this
 *   policy, which would hand back every guarantee above at hop two.
 * - **A wall-clock deadline covers the whole request**, not just the connect.
 *   A server that dribbles one byte per second passes every per-socket timeout
 *   ever written.
 *
 * ## What it does not do
 *
 * **robots.txt.** That is a caller's concern and belongs with the fetch
 * scheduler, not with transport policy — this module has no idea whether it is
 * being asked for a page, a manifest, or a capability endpoint, and those have
 * different rules. Do not assume a fetch through here is permitted; assume only
 * that it is safe.
 */

export type EgressConfig = {
	timeoutMs: number;
	maxBytes: number;
	maxRedirects: number;
	userAgent: string;
};

/**
 * The injection seam, and nothing more. Each of these has a correct production
 * default that is never overridden outside tests — they are constructor
 * parameters rather than configuration precisely so that no environment
 * variable can weaken the policy on a running service.
 */
export type EgressDeps = {
	/** Production resolves through the system resolver. */
	resolve?: (hostname: string) => Promise<string[]>;
	/** Overridden by tests that need to reach a loopback fixture server. */
	classify?: (address: string) => AddressVerdict;
	/** Overridden by tests, whose fixture servers listen on ephemeral ports. */
	allowPort?: (port: number) => boolean;
};

export type EgressResponse = {
	/** After redirects — always same-host with the requested URL. */
	url: string;
	status: number;
	headers: Record<string, string>;
	body: Buffer;
};

/**
 * Per-request options.
 *
 * POST exists here rather than in a second HTTP client because upstream search
 * providers are called over POST, and "one client, one policy" only holds if
 * there is nowhere else to make a request from. A vendor endpoint is a trusted
 * host, but it is still a public address on port 443 and the same rules apply
 * to it — including the deadline and the size cap, which are the two that
 * actually bite when a vendor has a bad day.
 */
export type EgressRequest = {
	method?: "GET" | "POST";
	body?: string;
	/** Merged over the defaults. `user-agent` cannot be overridden. */
	headers?: Record<string, string>;
};

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * A public host serving on 6379 is still Redis. The address rules already stop
 * the internal case; this stops the rest, and 80/443 is every URL a web
 * crawler has a legitimate reason to follow.
 */
const ALLOWED_PORTS = new Set([80, 443]);

/**
 * Drops a response body we have decided not to read — a redirect's, or one
 * that broke the size cap.
 *
 * `destroy()` alone is not enough: an undici body emits `UND_ERR_ABORTED` when
 * destroyed mid-flight, and a stream with no error listener promotes that to an
 * unhandled error. It does not fail the fetch, which is what makes it nasty —
 * it surfaces later, attached to whatever happened to be running, and in a test
 * run it points at the wrong test entirely.
 */
function discardBody(body: Readable): void {
	body.on("error", () => {});
	body.destroy();
}

async function systemResolve(hostname: string): Promise<string[]> {
	const results = await dnsLookup(hostname, { all: true, verbatim: true });
	return results.map((entry) => entry.address);
}

export function createEgressClient(
	config: EgressConfig,
	deps: EgressDeps = {},
) {
	const resolve = deps.resolve ?? systemResolve;
	const classify = deps.classify ?? classifyAddress;
	const allowPort =
		deps.allowPort ?? ((port: number) => ALLOWED_PORTS.has(port));

	/**
	 * Resolves a hostname and returns an address safe to connect to, or throws.
	 * A literal IP in the URL skips resolution and is judged directly — it is
	 * already the address that will be connected to.
	 */
	async function pin(hostname: string, url: string): Promise<string> {
		const literal = classifyLiteral(hostname);
		if (literal) {
			const verdict = classify(literal);
			if (!verdict.allowed) {
				throw new EgressError("blocked-address", url, verdict.reason);
			}
			return literal;
		}

		let addresses: string[];
		try {
			addresses = await resolve(hostname);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new EgressError("dns-failure", url, `${hostname}: ${detail}`);
		}

		if (addresses.length === 0) {
			throw new EgressError(
				"dns-failure",
				url,
				`${hostname} resolved to nothing`,
			);
		}

		for (const address of addresses) {
			const verdict = classify(address);
			if (!verdict.allowed) {
				throw new EgressError(
					"blocked-address",
					url,
					`${hostname} → ${verdict.reason}`,
				);
			}
		}

		return addresses[0] as string;
	}

	async function fetchOnce(
		target: URL,
		address: string,
		signal: AbortSignal,
		req: EgressRequest,
	): Promise<{
		status: number;
		headers: Record<string, string>;
		location: string | null;
		body: Buffer | null;
	}> {
		// A per-request agent, because the pin is per-request: the lookup below
		// closes over one validated address and hands it back without consulting
		// DNS again. Pooling across requests would mean sharing a connection
		// whose address was validated for a different URL.
		const family = address.includes(":") ? 6 : 4;
		const agent = new Agent({
			connect: {
				// Both callback shapes, because Node chooses between them: with
				// `autoSelectFamily` on — the default since Node 20 — `net.connect`
				// asks for `all: true` and expects an array of records, and passing
				// the single-address form there surfaces as "Invalid IP address:
				// undefined" from deep inside the connector.
				lookup: (_hostname, options, callback) => {
					if ((options as { all?: boolean } | undefined)?.all) {
						(
							callback as unknown as (
								error: null,
								addresses: Array<{ address: string; family: number }>,
							) => void
						)(null, [{ address, family }]);
						return;
					}
					callback(null, address, family);
				},
			},
			headersTimeout: config.timeoutMs,
			bodyTimeout: config.timeoutMs,
		});

		try {
			const response = await request(target, {
				method: req.method ?? "GET",
				body: req.body,
				dispatcher: agent,
				signal,
				// Redirects are handled by the caller loop, never here. undici does
				// not follow them unless its redirect interceptor is installed —
				// do not install it. Its following re-resolves and re-connects
				// outside this policy, which would hand back every guarantee above
				// at hop two.
				headers: {
					accept: "text/html,application/json;q=0.9,*/*;q=0.5",
					"accept-encoding": "gzip, deflate",
					// Caller headers override the two defaults above — an API client
					// wants its own accept and a content-type.
					...req.headers,
					// Last, and deliberately after the spread: we crawl and call under
					// a name an operator can block, and a caller able to overwrite it
					// would make that promise unenforceable.
					"user-agent": config.userAgent,
				},
			});

			const headers: Record<string, string> = {};
			for (const [key, value] of Object.entries(response.headers)) {
				if (typeof value === "string") headers[key] = value;
				else if (Array.isArray(value)) headers[key] = value.join(", ");
			}

			if (response.statusCode >= 300 && response.statusCode < 400) {
				const location = headers.location ?? null;
				discardBody(response.body);
				return { status: response.statusCode, headers, location, body: null };
			}

			// Checked before reading so an honest oversized response costs one
			// header round trip rather than the cap in bandwidth. A lying or
			// absent content-length is caught by the loop below.
			const declared = Number(headers["content-length"]);
			if (Number.isFinite(declared) && declared > config.maxBytes) {
				discardBody(response.body);
				throw new EgressError(
					"response-too-large",
					target.toString(),
					`content-length ${declared} exceeds ${config.maxBytes}`,
				);
			}

			const chunks: Buffer[] = [];
			let received = 0;
			for await (const chunk of response.body) {
				const buffer = Buffer.from(chunk);
				received += buffer.length;
				if (received > config.maxBytes) {
					discardBody(response.body);
					throw new EgressError(
						"response-too-large",
						target.toString(),
						`body exceeded ${config.maxBytes} bytes`,
					);
				}
				chunks.push(buffer);
			}

			return {
				status: response.statusCode,
				headers,
				location: null,
				body: Buffer.concat(chunks),
			};
		} finally {
			await agent.close().catch(() => {});
		}
	}

	return {
		async fetch(
			rawUrl: string,
			req: EgressRequest = {},
		): Promise<EgressResponse> {
			let target: URL;
			try {
				target = new URL(rawUrl);
			} catch {
				throw new EgressError("invalid-url", rawUrl, "not a URL");
			}

			// One deadline for the whole thing, redirects included. Per-hop
			// timeouts multiply: three hops at ten seconds each is thirty seconds
			// of a caller's budget spent inside one "ten second" fetch.
			const controller = new AbortController();
			const deadline = setTimeout(() => controller.abort(), config.timeoutMs);

			try {
				const origin = target.host;

				if (!ALLOWED_SCHEMES.has(target.protocol)) {
					throw new EgressError(
						"scheme-not-allowed",
						target.toString(),
						target.protocol,
					);
				}

				const port = target.port
					? Number(target.port)
					: target.protocol === "https:"
						? 443
						: 80;
				if (!allowPort(port)) {
					throw new EgressError(
						"port-not-allowed",
						target.toString(),
						`port ${port}`,
					);
				}

				// Resolved exactly once, for the whole request. `URL.host` carries
				// the port, so a redirect that changes either host or port is
				// already refused as cross-host below — which means the address
				// pinned here stays correct for every hop, and there is never a
				// second lookup for DNS to answer differently.
				const address = await pin(target.hostname, target.toString());

				for (let hop = 0; hop <= config.maxRedirects; hop += 1) {
					const result = await fetchOnce(
						target,
						address,
						controller.signal,
						req,
					);

					if (result.location === null) {
						return {
							url: target.toString(),
							status: result.status,
							headers: result.headers,
							body: result.body ?? Buffer.alloc(0),
						};
					}

					let next: URL;
					try {
						next = new URL(result.location, target);
					} catch {
						throw new EgressError(
							"invalid-url",
							target.toString(),
							`redirect to ${result.location}`,
						);
					}

					// Same host only. A cross-host redirect is how an allowed URL
					// becomes a disallowed one without the caller ever seeing the
					// second address.
					if (next.host !== origin) {
						throw new EgressError(
							"cross-host-redirect",
							target.toString(),
							`${origin} → ${next.host}`,
						);
					}

					target = next;
				}

				throw new EgressError(
					"too-many-redirects",
					target.toString(),
					`more than ${config.maxRedirects}`,
				);
			} catch (error) {
				if (error instanceof EgressError) throw error;
				if (controller.signal.aborted) {
					throw new EgressError(
						"timeout",
						target.toString(),
						`exceeded ${config.timeoutMs}ms`,
					);
				}
				const detail = error instanceof Error ? error.message : String(error);
				throw new EgressError("request-failed", target.toString(), detail);
			} finally {
				clearTimeout(deadline);
			}
		},
	};
}

export type EgressClient = ReturnType<typeof createEgressClient>;

/**
 * `new URL("http://[::1]/")` gives a hostname of `[::1]`; the brackets are URL
 * syntax and not part of the address. Returns the bare literal, or null when
 * the hostname is a name rather than an address.
 */
function classifyLiteral(hostname: string): string | null {
	const unwrapped =
		hostname.startsWith("[") && hostname.endsWith("]")
			? hostname.slice(1, -1)
			: hostname;
	return /^[\d.]+$/.test(unwrapped) || unwrapped.includes(":")
		? unwrapped
		: null;
}
