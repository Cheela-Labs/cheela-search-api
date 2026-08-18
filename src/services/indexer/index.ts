import { createHash } from "node:crypto";
import type { EgressClient, VespaClient } from "@cheela/search-core";
import {
	canonicalizeUrl,
	domainOf,
	envelope,
	isEgressError,
	STREAMS,
} from "@cheela/search-core";
import type pg from "pg";
import { publish } from "../../infra/redis/streams.js";
import { config } from "../../shared/config.js";
import { logger } from "../../shared/logger.js";
import { chunkText } from "./chunk.js";
import { extract } from "./extract.js";
import { isNearDuplicate, simhash, toSigned } from "./simhash.js";

export * from "./chunk.js";
export * from "./extract.js";
export * from "./simhash.js";

/**
 * The self-improving indexing pipeline, in the order both specifications give:
 *
 *   1 fetch → 2 clean → 3 canonicalize → 4 deduplicate → 5 chunk →
 *   6 metadata → 7 entities → 8 embed → 9 index → 10 graph
 *
 * Steps 8 and 9 are one call. Embedding happens *inside Vespa* — the schema's
 * `indexing: input chunks | embed e5` runs the model on the feed path — so
 * there is no separate embedding step to write, no embedding cache to keep
 * coherent, and no way for the vectors in the index to disagree with the text
 * beside them.
 *
 * Nothing here runs on the request path. The user never waits for indexing.
 */

export type IndexOutcome =
	| { status: "indexed"; docId: string; chunks: number; replaced: boolean }
	| { status: "duplicate"; of: string }
	| { status: "refused"; reason: string }
	| { status: "failed"; reason: string };

export type IndexerDeps = {
	pool: pg.Pool;
	vespa: VespaClient;
	egress: EgressClient;
	/**
	 * Archives raw HTML so re-extraction never needs a re-crawl.
	 *
	 * Returns undefined when the write failed, rather than throwing. Archiving is
	 * best-effort by design: losing the copy costs a future re-extraction, never
	 * the document being indexed right now.
	 */
	archive?: (
		key: string,
		body: Buffer,
		contentType: string,
	) => Promise<string | undefined>;
	/**
	 * Entities and relationships found in the text. Steps 7 and 10.
	 *
	 * Returns both together because they are one extraction: an edge whose ends
	 * are not in the same entity list cannot be inserted, since graph.edges has
	 * foreign keys to graph.entities.
	 */
	extract?: (
		text: string,
		title: string,
	) => Promise<{
		entities: { name: string; type: string; confidence: number }[];
		edges: {
			source: string;
			relation: string;
			target: string;
			confidence: number;
		}[];
	}>;
};

export type IndexInput = {
	url: string;
	/** Supplied by `POST /index/document`; fetched when absent. */
	title?: string;
	body?: string;
	language?: string;
	publishedAt?: number;
	authority?: number;
};

const docIdFor = (canonical: string): string =>
	createHash("sha256").update(canonical).digest("hex").slice(0, 24);

/**
 * A crude authority prior, used only until there is click evidence.
 *
 * It is deliberately shallow — a handful of structural signals, no allowlist of
 * "good" publishers. An editorial allowlist would be a claim about the web that
 * this project has no basis for, and it is exactly the kind of thing that is
 * easy to add and impossible to remove.
 */
export function priorAuthority(url: string): number {
	let score = 0.5;
	try {
		const parsed = new URL(url);
		if (parsed.protocol === "https:") score += 0.05;
		if (/\.(gov|edu|int)$/.test(parsed.hostname)) score += 0.2;
		if (/\.(org|ac\.[a-z]{2})$/.test(parsed.hostname)) score += 0.05;
		// Deep paths and long query strings correlate with generated pages.
		const depth = parsed.pathname.split("/").filter(Boolean).length;
		if (depth > 5) score -= 0.1;
		if (parsed.search.length > 60) score -= 0.1;
	} catch {
		return 0.5;
	}
	return Math.min(1, Math.max(0, score));
}

export function createIndexer(deps: IndexerDeps) {
	async function findDuplicate(
		canonical: string,
		fingerprint: bigint,
		contentHash: string,
	): Promise<string | null> {
		const { rows } = await deps.pool.query<{ doc_id: string; simhash: string }>(
			`SELECT doc_id, simhash FROM search.documents
			 WHERE content_hash = $1 OR (simhash IS NOT NULL AND canonical_url <> $2)
			 ORDER BY (content_hash = $1) DESC
			 LIMIT 200`,
			[contentHash, canonical],
		);

		for (const row of rows) {
			if (row.simhash === null) continue;
			if (
				isNearDuplicate(BigInt.asUintN(64, BigInt(row.simhash)), fingerprint)
			) {
				return row.doc_id;
			}
		}
		return null;
	}

	return {
		async index(input: IndexInput): Promise<IndexOutcome> {
			// ---- 1 fetch, 2 clean -------------------------------------------
			let title = input.title ?? "";
			let text = input.body ?? "";
			let language = input.language ?? "en";
			let publishedAt = input.publishedAt ?? 0;
			let image: string | undefined;
			let canonical = canonicalizeUrl(input.url);
			let archived: string | undefined;

			if (!text) {
				let response: Awaited<ReturnType<EgressClient["fetch"]>>;
				try {
					response = await deps.egress.fetch(input.url, { crawl: true });
				} catch (error) {
					if (isEgressError(error)) {
						// robots-disallowed is a refusal, not a failure: retrying it
						// will produce the same answer and should not be requeued.
						return error.reason === "robots-disallowed"
							? { status: "refused", reason: error.reason }
							: { status: "failed", reason: error.reason };
					}
					return { status: "failed", reason: "unknown" };
				}

				if (response.status >= 400) {
					return { status: "failed", reason: `http-${response.status}` };
				}

				const extracted = extract(
					response.body.toString("utf8"),
					response.url,
					response.headers["content-type"] ?? "text/html",
				);

				if (deps.archive) {
					// Archived before extraction is judged: a page that extracts
					// badly today is the page a better extractor should get to try
					// again tomorrow, without asking the origin for it twice.
					archived = await deps
						.archive(
							`${domainOf(response.url)}/${docIdFor(canonicalizeUrl(response.url))}.html`,
							response.body,
							response.headers["content-type"] ?? "text/html",
						)
						.catch(() => undefined);
				}

				if (!extracted.ok) {
					return { status: "refused", reason: extracted.reason };
				}

				title = extracted.extraction.title;
				text = extracted.extraction.text;
				language = extracted.extraction.language ?? language;
				publishedAt = extracted.extraction.publishedAt ?? 0;
				image = extracted.extraction.image ?? undefined;
				// ---- 3 canonicalize ------------------------------------------
				canonical = canonicalizeUrl(
					extracted.extraction.canonicalUrl ?? response.url,
				);
			}

			const domain = domainOf(canonical);
			if (!domain) return { status: "failed", reason: "unparseable-url" };

			// ---- 4 deduplicate -----------------------------------------------
			const contentHash = createHash("sha256").update(text).digest("hex");
			const fingerprint = simhash(text);
			const docId = docIdFor(canonical);

			try {
				const duplicate = await findDuplicate(
					canonical,
					fingerprint,
					contentHash,
				);
				if (duplicate && duplicate !== docId) {
					return { status: "duplicate", of: duplicate };
				}
			} catch (error) {
				// A failed duplicate check costs a redundant document, not the
				// document. Indexing it twice is recoverable; dropping it is not.
				logger.warn(
					{ error: (error as Error).message },
					"duplicate check failed; indexing anyway",
				);
			}

			// ---- 5 chunk ------------------------------------------------------
			const chunks = chunkText(text);
			if (chunks.length === 0)
				return { status: "refused", reason: "no-content" };

			// ---- 6 metadata, 7 entities ---------------------------------------
			const authority = input.authority ?? priorAuthority(canonical);
			const extraction = (await deps
				.extract?.(text, title)
				.catch(() => null)) ?? { entities: [], edges: [] };

			const entityWeights: Record<string, number> = {};
			for (const entity of extraction.entities.slice(0, 24)) {
				entityWeights[entity.name] = entity.confidence;
			}

			// ---- 8 embed, 9 index ---------------------------------------------
			const parsed = new URL(canonical);
			const replaced = await deps.pool
				.query<{ exists: boolean }>(
					"SELECT true AS exists FROM search.documents WHERE doc_id = $1",
					[docId],
				)
				.then((result) => result.rows.length > 0)
				.catch(() => false);

			await deps.vespa.put("web_document", docId, {
				doc_id: docId,
				url: canonical,
				domain,
				path: parsed.pathname,
				title,
				// Bounded: Vespa will embed this, and the embedder's window is
				// finite. The chunks carry the whole document; this field is for
				// lexical matching and the summary.
				body: text.slice(0, 60_000),
				chunks: chunks.map((chunk) => chunk.text),
				language,
				authority,
				freshness: 0.5,
				published_at: publishedAt,
				indexed_at: Math.floor(Date.now() / 1000),
				entities: Object.keys(entityWeights),
				entity_weights: entityWeights,
				graph_importance: 0,
				// simhash is deliberately not fed. It is a 64-bit value, JSON
				// numbers lose precision above 2^53, and truncating it would put a
				// fingerprint in the index that silently disagrees with the one in
				// Postgres. Deduplication reads Postgres, which holds it exactly.
				...(image ? { image } : {}),
			});

			await deps.pool.query(
				`INSERT INTO search.documents
				   (doc_id, url, canonical_url, domain, title, language, content_hash,
				    simhash, http_status, fetched_at, expires_at, published_at,
				    indexed_at, authority, raw_object)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,200,now(),now() + ($9 || ' milliseconds')::interval,
				         CASE WHEN $10::bigint > 0 THEN to_timestamp($10::bigint) END,
				         now(),$11,$12)
				 ON CONFLICT (canonical_url) DO UPDATE SET
				   title = EXCLUDED.title,
				   content_hash = EXCLUDED.content_hash,
				   simhash = EXCLUDED.simhash,
				   fetched_at = now(),
				   expires_at = EXCLUDED.expires_at,
				   indexed_at = now(),
				   authority = EXCLUDED.authority,
				   raw_object = COALESCE(EXCLUDED.raw_object, search.documents.raw_object)`,
				[
					docId,
					input.url,
					canonical,
					domain,
					title,
					language,
					contentHash,
					toSigned(fingerprint).toString(),
					String(config.DOCUMENT_CACHE_TTL_MS),
					String(publishedAt),
					authority,
					archived ?? null,
				],
			);

			// ---- 10 graph ------------------------------------------------------
			//
			// Published rather than written here. The graph is the worker's to
			// update: an upsert per entity plus one per edge is a dozen statements,
			// and `POST /index/document` is a request somebody is waiting on.
			if (extraction.entities.length > 0) {
				void publish(
					STREAMS.graph,
					envelope({
						type: "EntitiesExtracted" as const,
						docId,
						entities: extraction.entities,
						edges: extraction.edges,
					}),
				);
			}

			void publish(
				STREAMS.index,
				envelope({
					type: "DocumentIndexed" as const,
					docId,
					url: canonical,
					domain,
					chunks: chunks.length,
					replaced,
				}),
			);

			return { status: "indexed", docId, chunks: chunks.length, replaced };
		},
	};
}

export type Indexer = ReturnType<typeof createIndexer>;
