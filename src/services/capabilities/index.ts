import type pg from "pg";
import type { CapabilityRef } from "../../contracts/search.js";
import { logger } from "../../shared/logger.js";

/**
 * Capabilities, read-only.
 *
 * Registration moved to the Console (ADR-003) and `POST /capabilities/register`
 * is gone with it: it accepted a hand-posted body, and capabilities may only
 * originate from a published `/.well-known/agent-discovery.json`. A second
 * ingest path is a second reader, and the second reader is the one nobody
 * exercises.
 *
 * What remains is the join this service needs at query time — what a result's
 * domain can do — which reads a table the Console owns the writes to.
 */

export type CapabilityDeps = { pool: pg.Pool };

export function createCapabilities(deps: CapabilityDeps) {
	return {
		/**
		 * What each of these domains can do, for decorating results.
		 *
		 * One statement for every domain in the result set rather than one per
		 * domain: this runs on the request path, and ten round trips to
		 * decorate ten results is ten times the latency for the same answer.
		 */
		async forDomains(domains: string[]): Promise<Map<string, CapabilityRef[]>> {
			const out = new Map<string, CapabilityRef[]>();
			if (domains.length === 0) return out;

			try {
				const { rows } = await deps.pool.query<{
					domain: string;
					invocation_name: string;
					effects: string;
					callable: boolean;
				}>(
					`SELECT domain, invocation_name, effects, callable
					   FROM capability.capabilities
					  WHERE domain = ANY($1)
					  ORDER BY domain, popularity DESC
					  LIMIT 200`,
					[domains],
				);

				for (const row of rows) {
					const existing = out.get(row.domain) ?? [];
					existing.push({
						domain: row.domain,
						invocationName: row.invocation_name,
						effects: row.effects as CapabilityRef["effects"],
						callable: row.callable,
					});
					out.set(row.domain, existing);
				}
			} catch (error) {
				// Decoration is not the answer. Losing it costs chips on cards.
				logger.warn(
					{ error: (error as Error).message },
					"capability lookup failed",
				);
			}

			return out;
		},
	};
}

export type Capabilities = ReturnType<typeof createCapabilities>;
