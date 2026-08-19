import { normalizeQuery } from "@cheela/search-core";
import type pg from "pg";
import { logger } from "../../shared/logger.js";

/**
 * The Entity Registry, read side.
 *
 * Which domain officially speaks for a name. The Console writes this
 * (ADR-003); the Search Service only ever reads it, and reads all of it at
 * once rather than a row at a time.
 *
 * ## Why the whole table, in memory
 *
 * This is consulted *before* the intent model call, on every query, to answer
 * "is this a name we know". A Postgres round trip there would cost more than
 * the model call it exists to avoid — the entire point of the structural pass
 * in the intent engine is that a meaningful share of queries are decidable
 * without paying for a network hop. A few thousand rows of name, domain and
 * aliases is a few hundred kilobytes, and it is the same answer for every
 * replica.
 *
 * Refreshed on a timer rather than invalidated, because nothing that writes it
 * can reach this process, and because being a few minutes behind on "redis.io
 * is Redis" costs nothing. A registry that is empty because the refresh failed
 * is a different matter, which is why `size` is reported and a failed load
 * leaves the previous map in place rather than clearing it.
 */

export type RegistryEntity = {
	entityId: string;
	name: string;
	type: string;
	officialDomain: string;
	officialUrl: string | null;
	faviconUrl: string | null;
	/** 0..1. `verified` is 1, a publisher's own JSON-LD 0.8, the seed list 0.6. */
	confidence: number;
};

export type EntityRegistryDeps = {
	pool: pg.Pool;
	/** How long a loaded map is served before a refresh is attempted. */
	ttlMs?: number;
	limit?: number;
};

const DEFAULT_TTL_MS = 10 * 60_000;

/**
 * The lookup key for a surface form.
 *
 * `normalizeQuery` rather than a bespoke lowercase, so a name is keyed exactly
 * as the query that will look it up is keyed. Anything else and "Node.js"
 * indexes under one string and the user's `node.js` searches for another —
 * silently, with no error, for exactly the punctuated names most likely to be
 * typed.
 */
const keyOf = (surface: string): string => normalizeQuery(surface);

export function createEntityRegistry(deps: EntityRegistryDeps) {
	const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
	const limit = deps.limit ?? 20_000;

	let byAlias = new Map<string, RegistryEntity>();
	let loadedAt = 0;
	let loading: Promise<void> | null = null;

	async function load(): Promise<void> {
		const { rows } = await deps.pool.query<{
			entity_id: string;
			name: string;
			node_type: string;
			aliases: string[];
			official_domain: string;
			official_url: string | null;
			favicon_url: string | null;
			domain_confidence: number;
		}>(
			`SELECT entity_id, name, node_type, aliases, official_domain,
			        official_url, favicon_url, domain_confidence
			   FROM graph.entities
			  WHERE official_domain IS NOT NULL
			  ORDER BY domain_confidence ASC, popularity ASC
			  LIMIT $1`,
			[limit],
		);

		// Ascending, so a later row overwrites an earlier one and the strongest
		// evidence ends up owning a contested alias. Two entities can legitimately
		// answer to the same short name — a company and its product — and the one
		// whose domain somebody proved beats the one somebody typed into a seed
		// file.
		const next = new Map<string, RegistryEntity>();
		for (const row of rows) {
			const entity: RegistryEntity = {
				entityId: row.entity_id,
				name: row.name,
				type: row.node_type,
				officialDomain: row.official_domain,
				officialUrl: row.official_url,
				faviconUrl: row.favicon_url,
				confidence: row.domain_confidence,
			};
			for (const surface of [row.name, ...(row.aliases ?? [])]) {
				const key = keyOf(surface);
				if (key) next.set(key, entity);
			}
		}

		byAlias = next;
		loadedAt = Date.now();
		logger.info(
			{ entities: rows.length, aliases: byAlias.size },
			"entity registry loaded",
		);
	}

	async function refresh(): Promise<void> {
		if (Date.now() - loadedAt < ttlMs) return;
		// One in-flight load, shared. Without this a cold start under load fires
		// a full table read per concurrent request.
		loading ??= load()
			.catch((error: Error) => {
				// The previous map is kept. An empty registry is not a neutral
				// state — it turns every navigational query back into an LLM guess,
				// silently — so a failed refresh must not be the thing that
				// produces one.
				logger.warn(
					{ error: error.message, entries: byAlias.size },
					"entity registry refresh failed; serving the previous map",
				);
				// Deliberately *not* stamping `loadedAt` on a failure when the map
				// is empty. Marking a failed cold load as fresh is what turns one
				// bad minute at startup into a permanently empty registry; leaving
				// it stale means the next tick tries again. When there is a
				// previous map to serve, the stamp is fine — that is a real cache,
				// not an absence.
				if (byAlias.size > 0) loadedAt = Date.now();
			})
			.finally(() => {
				loading = null;
			});
		await loading;
	}

	let timer: NodeJS.Timeout | null = null;

	return {
		/**
		 * Warms the map, and keeps it warm.
		 *
		 * The timer is the point, and it was missing at first: this comment said
		 * "refreshed on a timer" while nothing ever called `refresh` after
		 * startup. A revision that came up before the registry's own migration
		 * had run therefore loaded nothing, logged one warning, and served an
		 * empty map for the life of the process — every navigational query
		 * falling through to the model, silently, exactly as if the feature had
		 * never been deployed. That is what shipped, and it is why this is a
		 * loop rather than a single call.
		 *
		 * `unref` so a Job or a test that finishes its work is not held open by
		 * a pending refresh.
		 */
		async ready(): Promise<void> {
			await refresh();
			if (timer) clearInterval(timer);
			timer = setInterval(() => {
				void refresh();
			}, ttlMs);
			timer.unref();
		},

		/** Stops the refresh loop. For tests and for shutdown. */
		stop(): void {
			if (timer) clearInterval(timer);
			timer = null;
		},

		/**
		 * Synchronous by design.
		 *
		 * The caller is the structural pass in the intent engine, which runs
		 * before any await and whose whole value is that it costs nothing. An
		 * async lookup here would make it as expensive as the model call it
		 * replaces.
		 */
		lookup(surface: string): RegistryEntity | null {
			return byAlias.get(keyOf(surface)) ?? null;
		},

		/** Kicked off after a response is sent, never awaited on the request path. */
		refresh,

		get size(): number {
			return byAlias.size;
		},
	};
}

export type EntityRegistry = ReturnType<typeof createEntityRegistry>;
