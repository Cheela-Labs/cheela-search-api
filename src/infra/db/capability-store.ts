import type { Pool } from "pg";

import type {
	Effects,
	ManifestProbe,
	ReadCapability,
} from "../../domain/capability/manifest";
import { logger } from "../../shared/logger";

/**
 * The capability plane's storage.
 *
 * Two operations that look alike and are not: `capabilitiesFor` runs on the
 * request path and must be a hash join on domain and nothing else, while
 * everything below it runs in the probe job and may take as long as it likes.
 * PLAN.md is explicit that a manifest fetched during a query "would blow the
 * 60 ms capability-lookup budget and the 'chips visible before the answer'
 * argument with it".
 */

export type SiteCapability = {
	domain: string;
	name: string;
	invocationName: string | null;
	description: string | null;
	effects: Effects;
	invocableByUs: boolean;
};

/** A domain due for a manifest probe. */
export type DueSite = { domain: string; etag: string | null };

export class CapabilityStore {
	private readonly pool: Pool;

	constructor(pool: Pool) {
		this.pool = pool;
	}

	/**
	 * Every capability for these domains. **The request-path read.**
	 *
	 * One statement, `= ANY($1)`, so the cost is a single index scan however
	 * many sources a result set has. Errors degrade to an empty map: a search
	 * that cannot reach the capability plane is a search without chips, never a
	 * failed search.
	 */
	async capabilitiesFor(
		domains: readonly string[],
	): Promise<Map<string, SiteCapability[]>> {
		const byDomain = new Map<string, SiteCapability[]>();
		if (domains.length === 0) return byDomain;

		try {
			const { rows } = await this.pool.query<{
				domain: string;
				name: string;
				invocation_name: string | null;
				description: string | null;
				effects: Effects;
				invocable_by_us: boolean;
			}>(
				`SELECT domain, name, invocation_name, description, effects, invocable_by_us
				   FROM capability.capabilities
				  WHERE domain = ANY($1) AND deprecated = false
				  ORDER BY domain, name`,
				[[...new Set(domains)]],
			);

			for (const row of rows) {
				const list = byDomain.get(row.domain) ?? [];
				list.push({
					domain: row.domain,
					name: row.name,
					invocationName: row.invocation_name,
					description: row.description,
					effects: row.effects,
					invocableByUs: row.invocable_by_us,
				});
				byDomain.set(row.domain, list);
			}
		} catch (error) {
			logger.warn({ err: error }, "Capability lookup failed");
		}

		return byDomain;
	}

	/**
	 * Records that these domains exist and are worth probing.
	 *
	 * Called with every domain in a result set — the opportunistic source
	 * PLAN.md prefers, because it is "weighted by what people actually search
	 * for, which beats any static ranking list". `DO NOTHING` on conflict, so a
	 * domain seen a thousand times keeps its original `next_probe_at` rather
	 * than being pushed back by its own popularity.
	 */
	async enqueue(domains: readonly string[]): Promise<void> {
		const unique = [...new Set(domains)].filter(Boolean);
		if (unique.length === 0) return;

		try {
			await this.pool.query(
				`INSERT INTO capability.sites (domain, discovery_method)
				 SELECT unnest($1::text[]), 'traffic'
				 ON CONFLICT (domain) DO NOTHING`,
				[unique],
			);
		} catch (error) {
			logger.warn({ err: error }, "Capability enqueue failed");
		}
	}

	/** What the probe job should look at, oldest due first. */
	async due(limit: number): Promise<DueSite[]> {
		const { rows } = await this.pool.query<{
			domain: string;
			etag: string | null;
		}>(
			`SELECT s.domain,
			        (SELECT m.etag FROM capability.manifests m
			          WHERE m.domain = s.domain
			          ORDER BY m.fetched_at DESC LIMIT 1) AS etag
			   FROM capability.sites s
			  WHERE s.next_probe_at <= now()
			  ORDER BY s.next_probe_at
			  LIMIT $1`,
			[limit],
		);
		return rows;
	}

	/**
	 * Writes what a probe found.
	 *
	 * The manifest row is kept whether or not it validated — "kept, never
	 * dropped" — because an invalid manifest is evidence about the spec in the
	 * wild, and deleting it makes that unmeasurable.
	 *
	 * Capabilities are replaced wholesale for the domain rather than merged. A
	 * capability removed from a manifest has been withdrawn by its publisher,
	 * and leaving it indexed would advertise something the site has stopped
	 * offering.
	 */
	async record(domain: string, probe: ManifestProbe): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");

			if (probe.state === "absent" || probe.state === "unreadable") {
				// **A 404 is the normal outcome and never an alert.** Recheck in 30
				// days: a site that publishes a manifest tomorrow should be found
				// without a full re-crawl.
				await client.query(
					`UPDATE capability.sites
					    SET adp_state = $2,
					        last_probed_at = now(),
					        next_probe_at = now() + interval '30 days'
					  WHERE domain = $1`,
					[domain, probe.state],
				);
				await client.query("COMMIT");
				return;
			}

			const { rows } = await client.query<{ id: string }>(
				`INSERT INTO capability.manifests
				        (domain, url, raw_json, content_hash, spec_version, valid,
				         validation_errors, etag)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
				 ON CONFLICT (domain, content_hash) DO UPDATE
				    SET fetched_at = now(), etag = EXCLUDED.etag
				 RETURNING id`,
				[
					domain,
					probe.url,
					JSON.stringify(probe.raw),
					probe.hash,
					probe.specVersion,
					probe.state === "valid",
					probe.state === "invalid" ? JSON.stringify(probe.errors) : null,
					probe.etag,
				],
			);
			const manifestId = rows[0]?.id;

			if (probe.state === "valid" && manifestId) {
				await client.query(
					"DELETE FROM capability.capabilities WHERE domain = $1",
					[domain],
				);
				for (const capability of probe.capabilities) {
					await insertCapability(client, manifestId, domain, capability);
				}
			}

			await client.query(
				`UPDATE capability.sites
				    SET adp_state = $2,
				        last_probed_at = now(),
				        next_probe_at = now() + interval '7 days'
				  WHERE domain = $1`,
				[domain, probe.state],
			);

			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK").catch(() => {});
			logger.warn({ err: error, domain }, "Capability record failed");
		} finally {
			client.release();
		}
	}
}

async function insertCapability(
	client: { query: Pool["query"] },
	manifestId: string,
	domain: string,
	capability: ReadCapability,
): Promise<void> {
	await client.query(
		`INSERT INTO capability.capabilities
		        (manifest_id, domain, name, invocation_name, version, description,
		         transport, auth, address, effects, invocable_by_us, deprecated,
		         extensions)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
		[
			manifestId,
			domain,
			capability.name,
			capability.invocationName,
			capability.version,
			capability.description,
			capability.transport,
			capability.auth,
			capability.address,
			capability.effects,
			capability.invocableByUs,
			capability.deprecated,
			capability.extensions ? JSON.stringify(capability.extensions) : null,
		],
	);
}
