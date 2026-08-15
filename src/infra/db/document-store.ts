import type { Pool } from "pg";

import type { Extraction } from "../../domain/retrieval/extract";
import { config } from "../../shared/config";
import { logger } from "../../shared/logger";

/**
 * A page we already have, and what we may do with it.
 *
 * `fresh` means serve it without asking the network anything. `stale` means we
 * still hold the bytes but the TTL has passed — worth a conditional request,
 * which either costs one round trip and no body (`304`) or replaces the row.
 */
export type CachedDocument = {
	url: string;
	canonicalUrl: string;
	domain: string;
	status: number;
	extraction: Extraction;
	etag: string | null;
	fresh: boolean;
};

export interface DocumentStore {
	/** The row for this URL, whether or not it has expired. */
	get(url: string): Promise<CachedDocument | null>;
	put(input: PutDocument): Promise<void>;
	/** A 304 said the page is unchanged — push the expiry out without a rewrite. */
	touch(canonicalUrl: string): Promise<void>;
}

export type PutDocument = {
	requestedUrl: string;
	finalUrl: string;
	domain: string;
	status: number;
	extraction: Extraction;
	etag: string | null;
};

type Row = {
	url: string;
	canonical_url: string;
	domain: string;
	title: string | null;
	image: string | null;
	extracted_text: string | null;
	content_hash: string;
	http_status: number;
	etag: string | null;
	expires_at: Date | null;
	published_at: Date | null;
};

/**
 * The content cache, over `web.documents`.
 *
 * **This is the strategic one.** PLAN.md: the dominant cost per query is
 * upstream API calls and page fetches, and the content cache "fills along the
 * shape of real traffic, so head queries go warm quickly and the upstream bill
 * flattens against volume rather than tracking it". The Phase 0 gate is a
 * content hit rate above 0.55.
 *
 * Every method swallows its own errors and degrades to a miss. A cache that can
 * take the service down when the database is slow is worse than no cache — the
 * pipeline ran without this table for its whole life and must keep being able
 * to.
 */
export class PostgresDocumentStore implements DocumentStore {
	private readonly pool: Pool;
	private readonly ttlMs: number;

	constructor(pool: Pool, ttlMs: number = config.CONTENT_CACHE_TTL_MS) {
		this.pool = pool;
		this.ttlMs = ttlMs;
	}

	async get(url: string): Promise<CachedDocument | null> {
		try {
			// Matched on either column: `canonical_url` is what the page calls
			// itself and `url` is what we were told to fetch. Before a fetch we only
			// have the latter, and after one we prefer the former.
			const { rows } = await this.pool.query<Row>(
				`SELECT url, canonical_url, domain, title, image, extracted_text,
				        content_hash, http_status, etag, expires_at, published_at
				   FROM web.documents
				  WHERE canonical_url = $1 OR url = $1
				  LIMIT 1`,
				[url],
			);

			const row = rows[0];
			if (!row) return null;

			// A row with no text is a page we fetched and could not read. Keeping it
			// would cache a failure and stop us ever retrying, so it is treated as
			// absent — the fetch path will try again and may do better.
			if (!row.extracted_text) return null;

			return {
				url: row.url,
				canonicalUrl: row.canonical_url,
				domain: row.domain,
				status: row.http_status,
				etag: row.etag,
				fresh: row.expires_at !== null && row.expires_at.getTime() > Date.now(),
				extraction: {
					title: row.title,
					canonicalUrl: row.canonical_url,
					image: row.image,
					text: row.extracted_text,
					publishedAt: row.published_at?.toISOString() ?? null,
					contentHash: row.content_hash,
				},
			};
		} catch (error) {
			logger.warn({ err: error, url }, "Content cache read failed");
			return null;
		}
	}

	async put(input: PutDocument): Promise<void> {
		try {
			await this.pool.query(
				`INSERT INTO web.documents
				        (url, canonical_url, domain, title, image, extracted_text,
				         content_hash, http_status, etag, published_at,
				         fetched_at, expires_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $11, now(), now() + ($10::bigint * interval '1 millisecond'))
				 ON CONFLICT (canonical_url) DO UPDATE
				    SET url            = EXCLUDED.url,
				        domain         = EXCLUDED.domain,
				        title          = EXCLUDED.title,
				        image          = EXCLUDED.image,
				        extracted_text = EXCLUDED.extracted_text,
				        content_hash   = EXCLUDED.content_hash,
				        http_status    = EXCLUDED.http_status,
				        etag           = EXCLUDED.etag,
				        published_at   = EXCLUDED.published_at,
				        fetched_at     = now(),
				        expires_at     = EXCLUDED.expires_at`,
				[
					input.requestedUrl,
					input.extraction.canonicalUrl,
					input.domain,
					input.extraction.title,
					input.extraction.image,
					input.extraction.text,
					input.extraction.contentHash,
					input.status,
					input.etag,
					this.ttlMs,
					input.extraction.publishedAt,
				],
			);
		} catch (error) {
			logger.warn(
				{ err: error, url: input.requestedUrl },
				"Content cache write failed",
			);
		}
	}

	async touch(canonicalUrl: string): Promise<void> {
		try {
			await this.pool.query(
				`UPDATE web.documents
				    SET expires_at = now() + ($2::bigint * interval '1 millisecond'),
				        fetched_at = now()
				  WHERE canonical_url = $1`,
				[canonicalUrl, this.ttlMs],
			);
		} catch (error) {
			logger.warn({ err: error, canonicalUrl }, "Content cache touch failed");
		}
	}
}
