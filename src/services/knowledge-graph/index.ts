import { createHash } from "node:crypto";
import type { VespaClient } from "@cheela/search-core";
import type pg from "pg";
import type { EntityRef } from "../../contracts/search.js";
import type { Cache } from "../../infra/redis/cache.js";
import { logger } from "../../shared/logger.js";

/**
 * The Knowledge Graph.
 *
 * Postgres is the system of record: nodes, edges, confidence, and which
 * documents asserted what. Vespa holds a searchable projection for the one
 * job that has to be fast — matching an alias mid-request.
 *
 * ### Confidence is accumulated, not asserted
 *
 * An edge extracted once, from one sentence, and an edge seen in fifty
 * documents are not the same claim. Every write here raises confidence toward
 * 1 rather than overwriting it, so the number means "how much evidence" rather
 * than "what the last extractor happened to think".
 */

export const NODE_TYPES = [
	"Person",
	"Organization",
	"Product",
	"Event",
	"Place",
	"Technology",
	"Capability",
] as const;

export const EDGE_TYPES = [
	"founded",
	"owned_by",
	"located_in",
	"occurred_in",
	"part_of",
	"manufactured_by",
	"related_to",
] as const;

export type NodeType = (typeof NODE_TYPES)[number];
export type EdgeType = (typeof EDGE_TYPES)[number];

export type Edge = {
	source: string;
	relation: string;
	target: string;
	confidence: number;
};

/**
 * A stable id from the name, so the same entity extracted from two documents
 * on two days is one node rather than two.
 *
 * Case- and punctuation-folded, which is why "Larry Page" and "larry page"
 * converge. It is a deliberately simple resolver: real entity linking needs a
 * disambiguation model, and until there is one, silently merging "Apple" the
 * company with "apple" the fruit is a known limitation rather than a hidden
 * one.
 */
export function entityId(name: string, type: string): string {
	const normalized = name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
	return createHash("sha256")
		.update(`${type}:${normalized}`)
		.digest("hex")
		.slice(0, 20);
}

/** Bayesian-ish accumulation: each observation closes part of the gap to 1. */
export function accumulate(previous: number, observation: number): number {
	return Math.min(1, previous + observation * (1 - previous) * 0.5);
}

export type GraphDeps = {
	pool: pg.Pool;
	cache?: Cache<EntityRef[]>;
	/**
	 * Feeds the `entity` schema, which the retriever queries for aliases on
	 * every expansion and which nothing ever wrote to — so alias expansion,
	 * one of the evolution engine's three sources, always returned empty.
	 *
	 * Optional because Postgres is the system of record: a failed feed costs
	 * alias recall until the next mention, never the node.
	 */
	vespa?: VespaClient;
};

export function createGraph(deps: GraphDeps) {
	return {
		async upsertEntity(input: {
			name: string;
			type: string;
			aliases?: string[];
			description?: string;
			confidence?: number;
		}): Promise<string> {
			const id = entityId(input.name, input.type);
			await deps.pool.query(
				`INSERT INTO graph.entities (entity_id, name, node_type, aliases, description, popularity)
				 VALUES ($1,$2,$3,$4,$5,$6)
				 ON CONFLICT (entity_id) DO UPDATE SET
				   -- Aliases union rather than replace: two documents each know a
				   -- different short name for the same thing.
				   aliases = ARRAY(SELECT DISTINCT unnest(graph.entities.aliases || EXCLUDED.aliases)),
				   description = CASE
				     WHEN length(EXCLUDED.description) > length(graph.entities.description)
				     THEN EXCLUDED.description ELSE graph.entities.description END,
				   popularity = LEAST(1, graph.entities.popularity + 0.01),
				   updated_at = now()`,
				[
					id,
					input.name,
					input.type,
					input.aliases ?? [],
					input.description ?? "",
					input.confidence ?? 0.1,
				],
			);
			// Projected into Vespa for alias matching. After the upsert, so a
			// failed feed cannot leave the index holding an entity the graph does
			// not have.
			if (deps.vespa) {
				const { rows } = await deps.pool.query<{
					aliases: string[];
					description: string;
					popularity: number;
					graph_importance: number;
				}>(
					`SELECT aliases, description, popularity, graph_importance
					   FROM graph.entities WHERE entity_id = $1`,
					[id],
				);
				const row = rows[0];
				if (row) {
					await deps.vespa
						.put("entity", id, {
							entity_id: id,
							name: input.name,
							node_type: input.type,
							aliases: row.aliases,
							description: row.description,
							popularity: row.popularity,
							graph_importance: row.graph_importance,
							indexed_at: Math.floor(Date.now() / 1000),
						})
						.catch((error) => {
							logger.warn(
								{ error: (error as Error).message, entity: input.name },
								"could not project entity into the index",
							);
						});
				}
			}

			return id;
		},

		async upsertEdge(edge: Edge): Promise<void> {
			await deps.pool.query(
				`INSERT INTO graph.edges (source_id, relation, target_id, confidence)
				 VALUES ($1,$2,$3,$4)
				 ON CONFLICT (source_id, relation, target_id) DO UPDATE SET
				   confidence = LEAST(1, graph.edges.confidence
				     + EXCLUDED.confidence * (1 - graph.edges.confidence) * 0.5),
				   observations = graph.edges.observations + 1,
				   updated_at = now()`,
				[edge.source, edge.relation, edge.target, edge.confidence],
			);
		},

		async recordMention(
			docId: string,
			entityIds: { id: string; confidence: number }[],
		): Promise<void> {
			if (entityIds.length === 0) return;
			await deps.pool.query(
				`INSERT INTO graph.mentions (doc_id, entity_id, confidence)
				 SELECT $1, * FROM unnest($2::text[], $3::real[])
				 ON CONFLICT (doc_id, entity_id) DO UPDATE SET
				   confidence = GREATEST(graph.mentions.confidence, EXCLUDED.confidence)`,
				[
					docId,
					entityIds.map((entry) => entry.id),
					entityIds.map((entry) => entry.confidence),
				],
			);
		},

		/** `GET /entities/{id}`. */
		async get(id: string): Promise<
			| (EntityRef & {
					description: string;
					graphImportance: number;
					edges: { relation: string; target: EntityRef }[];
			  })
			| null
		> {
			const { rows } = await deps.pool.query<{
				entity_id: string;
				name: string;
				node_type: string;
				aliases: string[];
				description: string;
				popularity: number;
				graph_importance: number;
			}>(
				`SELECT entity_id, name, node_type, aliases, description, popularity, graph_importance
				   FROM graph.entities WHERE entity_id = $1`,
				[id],
			);

			const entity = rows[0];
			if (!entity) return null;

			const { rows: edges } = await deps.pool.query<{
				relation: string;
				entity_id: string;
				name: string;
				node_type: string;
				aliases: string[];
				popularity: number;
			}>(
				`SELECT e.relation, t.entity_id, t.name, t.node_type, t.aliases, t.popularity
				   FROM graph.edges e
				   JOIN graph.entities t ON t.entity_id = e.target_id
				  WHERE e.source_id = $1
				  ORDER BY e.confidence DESC
				  LIMIT 50`,
				[id],
			);

			return {
				id: entity.entity_id,
				name: entity.name,
				type: entity.node_type,
				aliases: entity.aliases,
				popularity: entity.popularity,
				description: entity.description,
				graphImportance: entity.graph_importance,
				edges: edges.map((row) => ({
					relation: row.relation,
					target: {
						id: row.entity_id,
						name: row.name,
						type: row.node_type,
						aliases: row.aliases,
						popularity: row.popularity,
					},
				})),
			};
		},

		/**
		 * Resolves the classifier's entity names to graph nodes.
		 *
		 * Cached for the TDS's one hour: entity records change on the timescale
		 * of the crawler, and the same handful of entities are asked for over
		 * and over within a session.
		 */
		async resolve(names: string[]): Promise<EntityRef[]> {
			if (names.length === 0) return [];

			const key = names
				.map((name) => name.toLowerCase())
				.sort()
				.join("|");
			const cached = await deps.cache?.get(key);
			if (cached) return cached;

			try {
				const { rows } = await deps.pool.query<{
					entity_id: string;
					name: string;
					node_type: string;
					aliases: string[];
					popularity: number;
				}>(
					`SELECT entity_id, name, node_type, aliases, popularity
					   FROM graph.entities
					  WHERE lower(name) = ANY($1) OR aliases && $2
					  ORDER BY popularity DESC
					  LIMIT 12`,
					[names.map((name) => name.toLowerCase()), names],
				);

				const entities = rows.map((row) => ({
					id: row.entity_id,
					name: row.name,
					type: row.node_type,
					aliases: row.aliases,
					popularity: row.popularity,
				}));

				void deps.cache?.put(key, entities);
				return entities;
			} catch (error) {
				logger.warn(
					{ error: (error as Error).message },
					"entity resolution failed",
				);
				return [];
			}
		},

		/** Aliases for query evolution. Names the graph knows this thing by. */
		async aliasesFor(names: string[]): Promise<string[]> {
			const entities = await this.resolve(names);
			return [
				...new Set(
					entities.flatMap((entity) => [entity.name, ...entity.aliases]),
				),
			]
				.filter(
					(alias) =>
						!names.some((name) => name.toLowerCase() === alias.toLowerCase()),
				)
				.slice(0, 4);
		},
	};
}

export type Graph = ReturnType<typeof createGraph>;
