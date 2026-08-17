import { request } from "undici";
import { config } from "../../shared/config.js";
import { logger } from "../../shared/logger.js";

/**
 * The Vespa client: feed, query, delete, count.
 *
 * ### Why this does not go through the egress client
 *
 * Vespa lives on a private address (10.148.0.2), and the egress client refuses
 * private addresses — correctly, because that is what stops an SSRF reaching
 * the metadata server. Routing internal traffic through it would mean either
 * punching a hole in the deny list or maintaining an exception, and both make
 * the outbound policy conditional in a file whose value comes from being
 * unconditional.
 *
 * The distinction that makes this safe is *who chose the address*. The egress
 * client exists for URLs chosen by strangers. This endpoint comes from
 * configuration we set, over a network only this project can route to. They
 * are different problems and they get different code.
 */

export type VespaHit = {
	id: string;
	relevance: number;
	fields: Record<string, unknown>;
};

export type VespaQueryResult = {
	hits: VespaHit[];
	totalCount: number;
	/** Vespa's own measure, so a slow query can be attributed to Vespa or to us. */
	searchTimeMs: number | null;
};

export class VespaError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "VespaError";
		this.status = status;
	}
}

export type VespaClient = ReturnType<typeof createVespaClient>;

export function createVespaClient(
	endpoint: string = config.VESPA_ENDPOINT,
	timeoutMs: number = config.VESPA_TIMEOUT_MS,
) {
	const base = endpoint.replace(/\/+$/, "");

	async function call<T>(
		path: string,
		init: {
			method: "GET" | "POST" | "PUT" | "DELETE";
			body?: unknown;
			timeoutMs?: number;
			signal?: AbortSignal;
		},
	): Promise<T> {
		const controller = new AbortController();
		const budget = init.timeoutMs ?? timeoutMs;
		const timer = setTimeout(() => controller.abort(), budget);
		const onAbort = () => controller.abort();
		init.signal?.addEventListener("abort", onAbort, { once: true });

		try {
			const response = await request(`${base}${path}`, {
				method: init.method,
				signal: controller.signal,
				headers: { "content-type": "application/json" },
				body: init.body === undefined ? undefined : JSON.stringify(init.body),
			});

			const text = await response.body.text();
			if (response.statusCode >= 400) {
				throw new VespaError(
					`vespa ${response.statusCode}: ${text.slice(0, 400)}`,
					response.statusCode,
				);
			}
			return (text ? JSON.parse(text) : {}) as T;
		} finally {
			clearTimeout(timer);
			init.signal?.removeEventListener("abort", onAbort);
		}
	}

	return {
		/**
		 * Runs a query. The body is Vespa's own JSON query API — YQL plus
		 * ranking inputs — because wrapping it in a query builder would hide
		 * exactly the part that needs to be readable when a ranking is wrong.
		 */
		async query(
			body: Record<string, unknown>,
			options: { signal?: AbortSignal; timeoutMs?: number } = {},
		): Promise<VespaQueryResult> {
			const response = await call<{
				root?: {
					children?: VespaHit[];
					fields?: { totalCount?: number };
					errors?: { message: string }[];
				};
				timing?: { searchtime?: number };
			}>("/search/", {
				method: "POST",
				body,
				signal: options.signal,
				timeoutMs: options.timeoutMs,
			});

			const root = response.root;
			if (root?.errors?.length) {
				throw new VespaError(
					root.errors.map((error) => error.message).join("; "),
					500,
				);
			}

			return {
				// Grouping and other non-hit children have no `fields`; filtering
				// on it keeps this returning documents only.
				hits: (root?.children ?? []).filter((child) => child.fields),
				totalCount: root?.fields?.totalCount ?? 0,
				searchTimeMs:
					typeof response.timing?.searchtime === "number"
						? response.timing.searchtime * 1000
						: null,
			};
		},

		async put(
			schema: string,
			docId: string,
			fields: Record<string, unknown>,
			options: { timeoutMs?: number } = {},
		): Promise<void> {
			await call(
				`/document/v1/default/${schema}/docid/${encodeURIComponent(docId)}`,
				{
					method: "POST",
					body: { fields },
					// Feeding runs a document through the embedder, which is far
					// slower than a query and must not share the query's budget.
					timeoutMs: options.timeoutMs ?? 30_000,
				},
			);
		},

		async remove(schema: string, docId: string): Promise<void> {
			await call(
				`/document/v1/default/${schema}/docid/${encodeURIComponent(docId)}`,
				{ method: "DELETE", timeoutMs: 10_000 },
			);
		},

		/** Index growth, which the TDS lists as a metric to watch. */
		async count(schema: string): Promise<number> {
			try {
				const response = await this.query({
					yql: `select * from ${schema} where true limit 0`,
					hits: 0,
					timeout: "5s",
				});
				return response.totalCount;
			} catch {
				return -1;
			}
		},

		async reachable(): Promise<boolean> {
			try {
				await call("/ApplicationStatus", { method: "GET", timeoutMs: 2000 });
				return true;
			} catch (error) {
				logger.debug({ error: (error as Error).message }, "vespa unreachable");
				return false;
			}
		},
	};
}

export const vespa = createVespaClient();
