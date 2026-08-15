import type { Pool } from "pg";

import { logger } from "../../shared/logger";
import { normalizeQuery } from "../../shared/normalize";

export interface QueryLog {
	record(query: string, resultDomains: readonly string[]): Promise<void>;
}

/**
 * The permanent demand record, over `web.query_log`.
 *
 * **This is not the query cache, and storing them as one object would throw the
 * asset away.** The cache answers "what did the vendor say ten minutes ago" and
 * expires; this answers "what do people actually ask for", never expires, and
 * is the seed corpus for owning an index later — weighted by real demand rather
 * than by what a crawler happened to reach.
 *
 * **The privacy shape is structural, not procedural.** The table has no user
 * id, session id or address column, so a query cannot be attributed to a person
 * even by mistake. That is deliberate: queries are health, legal, financial and
 * personal, and the guarantee worth having is the one that survives somebody
 * later writing careless code. Attribution would be a new table and a new
 * argument, not a column added here.
 *
 * Consequently this method takes a query and some domains, and there is nowhere
 * to put a caller identity even if one were passed.
 */
export class PostgresQueryLog implements QueryLog {
	private readonly pool: Pool;

	constructor(pool: Pool) {
		this.pool = pool;
	}

	async record(query: string, resultDomains: readonly string[]): Promise<void> {
		const normalized = normalizeQuery(query);
		if (!normalized) return;

		try {
			// Domains, not URLs. The demand signal is which *sites* answer a kind of
			// question — that is what a future index would be built to cover, and it
			// is also markedly less identifying than a full path would be.
			await this.pool.query(
				`INSERT INTO web.query_log (normalized_query, result_domains)
				 VALUES ($1, $2)`,
				[normalized, [...new Set(resultDomains)]],
			);
		} catch (error) {
			// Never fails a search. The log is an asset, not a dependency.
			logger.warn({ err: error }, "Query log write failed");
		}
	}
}
