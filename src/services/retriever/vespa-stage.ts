import {
	freshnessHalfLife,
	type Intent,
	intentBoost,
} from "../../contracts/intent.js";
import type { VespaClient, VespaHit } from "../../infra/vespa/client.js";
import { config } from "../../shared/config.js";
import { logger } from "../../shared/logger.js";

/**
 * Stage A: our own index.
 *
 * Searches the four collections the TDS names. `web_document` and `capability`
 * are searched for results; `entity` and `query_memory` are searched to inform
 * the query rather than to answer it, so they are separate calls with their
 * own small budgets and their own failure handling.
 *
 * Every query here is hybrid: `userQuery()` OR `nearestNeighbor()`. The OR is
 * load-bearing — an AND would return only documents that both match the words
 * and are near the vector, which is a smaller set than either, and the point
 * of hybrid retrieval is that the two find different things.
 */

export type IndexedDocument = {
	docId: string;
	url: string;
	domain: string;
	path: string;
	title: string;
	body: string;
	chunks: string[];
	image?: string;
	authority: number;
	publishedAt: number;
	score: number;
	features: Record<string, number>;
};

export type IndexedCapability = {
	capId: string;
	domain: string;
	invocationName: string;
	title: string;
	description: string;
	provider: string;
	auth: string;
	effects: string;
	callable: boolean;
	score: number;
};

const asString = (value: unknown, fallback = ""): string =>
	typeof value === "string" ? value : fallback;
const asNumber = (value: unknown, fallback = 0): number =>
	typeof value === "number" && Number.isFinite(value) ? value : fallback;

function features(hit: VespaHit): Record<string, number> {
	const raw = hit.fields.matchfeatures;
	if (typeof raw !== "object" || raw === null) return {};
	const out: Record<string, number> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value === "number") out[key] = value;
	}
	return out;
}

export function toDocument(hit: VespaHit): IndexedDocument {
	const fields = hit.fields;
	return {
		docId: asString(fields.doc_id),
		url: asString(fields.url),
		domain: asString(fields.domain),
		path: asString(fields.path),
		title: asString(fields.title),
		body: asString(fields.body),
		chunks: Array.isArray(fields.chunks)
			? (fields.chunks as unknown[]).filter(
					(chunk): chunk is string => typeof chunk === "string",
				)
			: [],
		image: asString(fields.image) || undefined,
		authority: asNumber(fields.authority, 0.5),
		publishedAt: asNumber(fields.published_at),
		score: hit.relevance,
		features: features(hit),
	};
}

export function toCapability(hit: VespaHit): IndexedCapability {
	const fields = hit.fields;
	return {
		capId: asString(fields.cap_id),
		domain: asString(fields.domain),
		invocationName: asString(fields.invocation_name),
		title: asString(fields.title),
		description: asString(fields.description),
		provider: asString(fields.provider),
		auth: asString(fields.auth, "none"),
		effects: asString(fields.effects, "unknown"),
		callable: fields.callable === true,
		score: hit.relevance,
	};
}

/**
 * The entity weights a query carries into ranking.
 *
 * Sent as a mapped tensor and multiplied against each document's own entity
 * weights, so `entity_boost` is the overlap between what the query is about
 * and what the document is about — not a keyword match on the entity's name.
 */
function entityTensor(entities: string[]): Record<string, number> {
	const cells: Record<string, number> = {};
	for (const entity of entities.slice(0, 12)) {
		if (entity) cells[entity] = 1;
	}
	return cells;
}

export type StageAOptions = {
	intent: Intent;
	entities: string[];
	limit: number;
	rerank: boolean;
	signal?: AbortSignal;
};

export function createIndexStage(vespa: VespaClient) {
	async function searchDocuments(
		query: string,
		options: StageAOptions,
	): Promise<IndexedDocument[]> {
		const result = await vespa.query(
			{
				yql:
					"select doc_id, url, domain, path, title, body, chunks, image, authority, published_at " +
					"from web_document where userQuery() or ({targetHits:100}nearestNeighbor(chunk_embeddings, q))",
				query,
				type: "weakAnd",
				"ranking.profile": options.rerank ? "hybrid-rerank" : "hybrid",
				"input.query(q)": "embed(e5, @query)",
				// Only sent for the reranking profile: tokenising the query is
				// wasted work when nothing will read the tokens.
				...(options.rerank
					? { "input.query(q_tokens)": "embed(tokenizer, @query)" }
					: {}),
				"input.query(q_entities)": entityTensor(options.entities),
				"input.query(intent_boost)": intentBoost(options.intent, "document"),
				"input.query(freshness_halflife)": freshnessHalfLife(options.intent),
				"input.query(now)": Math.floor(Date.now() / 1000),
				hits: options.limit,
				timeout: `${config.VESPA_TIMEOUT_MS}ms`,
				// Vespa returns what it has when the budget runs out rather than
				// failing. A slightly worse ranking beats a failed search.
				ranking: { softtimeout: { enable: true } },
			},
			{ signal: options.signal },
		);

		return result.hits.map(toDocument);
	}

	async function searchCapabilities(
		query: string,
		options: StageAOptions,
	): Promise<IndexedCapability[]> {
		const intents: Record<string, number> = { [options.intent]: 1 };
		const result = await vespa.query(
			{
				yql:
					"select cap_id, domain, invocation_name, title, description, provider, auth, effects, callable " +
					"from capability where userQuery() or ({targetHits:50}nearestNeighbor(embedding, q))",
				query,
				type: "weakAnd",
				"ranking.profile": "hybrid",
				"input.query(q)": "embed(e5, @query)",
				"input.query(q_intents)": intents,
				"input.query(intent_boost)": intentBoost(options.intent, "capability"),
				hits: 8,
				timeout: `${config.VESPA_TIMEOUT_MS}ms`,
			},
			{ signal: options.signal },
		);

		return result.hits.map(toCapability);
	}

	return {
		/**
		 * Documents and capabilities together, because they compete for the
		 * same result set and a query that returns one without the other has
		 * already decided which kind of answer the user wanted.
		 */
		async search(
			query: string,
			options: StageAOptions,
		): Promise<{
			documents: IndexedDocument[];
			capabilities: IndexedCapability[];
			failed: boolean;
		}> {
			const [documents, capabilities] = await Promise.all([
				searchDocuments(query, options).catch((error) => {
					// The TDS's failure table: "Vespa unavailable → external
					// retrieval". Reported as a failure so the orchestrator knows
					// to go to stage B rather than trusting an empty index.
					logger.warn(
						{ error: (error as Error).message },
						"vespa document search failed",
					);
					return null;
				}),
				searchCapabilities(query, options).catch(() => []),
			]);

			return {
				documents: documents ?? [],
				capabilities,
				failed: documents === null,
			};
		},

		/** Aliases for entity expansion. Feeds the Query Evolution engine. */
		async aliases(entities: string[], signal?: AbortSignal): Promise<string[]> {
			if (entities.length === 0) return [];
			try {
				const result = await vespa.query(
					{
						yql: "select name, aliases from entity where userQuery()",
						query: entities.join(" "),
						type: "any",
						"ranking.profile": "hybrid",
						"input.query(q)": "embed(e5, @query)",
						hits: 3,
						timeout: "150ms",
					},
					{ signal, timeoutMs: 200 },
				);

				const names = new Set<string>();
				for (const hit of result.hits) {
					const name = asString(hit.fields.name);
					if (name) names.add(name);
					const aliases = hit.fields.aliases;
					if (Array.isArray(aliases)) {
						for (const alias of aliases) {
							if (typeof alias === "string" && alias) names.add(alias);
						}
					}
				}
				return [...names].slice(0, 4);
			} catch {
				return [];
			}
		},

		/** Expansions this query has been given before, best first. */
		async remembered(query: string, signal?: AbortSignal): Promise<string[]> {
			try {
				const result = await vespa.query(
					{
						yql: "select expansions from query_memory where userQuery()",
						query,
						type: "weakAnd",
						"ranking.profile": "hybrid",
						"input.query(q)": "embed(e5, @query)",
						hits: 2,
						timeout: "150ms",
					},
					{ signal, timeoutMs: 200 },
				);

				const out: string[] = [];
				for (const hit of result.hits) {
					const expansions = hit.fields.expansions;
					if (Array.isArray(expansions)) {
						for (const entry of expansions) {
							if (typeof entry === "string" && entry) out.push(entry);
						}
					}
				}
				return out.slice(0, 3);
			} catch {
				return [];
			}
		},
	};
}

export type IndexStage = ReturnType<typeof createIndexStage>;
