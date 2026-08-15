import { Pool } from "pg";
import pino from "pino";

import { probeManifest } from "./domain/capability/manifest";
import { CapabilityStore } from "./infra/db/capability-store";
import { egress } from "./infra/egress";

/**
 * The manifest probe — `node dist/probe.js`, as a scheduled Cloud Run Job.
 *
 * **This is the reason capability chips can exist at all.** PLAN.md: "All of it
 * runs in the crawler, as a scheduled Cloud Run Job. **None of it runs on the
 * request path.** A manifest fetched during a query would blow the 60 ms
 * capability-lookup budget and the 'chips visible before the answer' argument
 * with it."
 *
 * So a query does two cheap things — a hash join on domain for what is already
 * known, and an `INSERT ... DO NOTHING` to note the domains it saw — and this
 * job does the fetching later, out of band, weighted by whatever people
 * actually searched for.
 *
 * ## Unlike `migrate.ts`, this one does load the service config
 *
 * The migration runner reads `DATABASE_URL` directly because it needs a
 * database and nothing else. This job crawls the open web, and
 * `infra/egress/index.ts` says why it must not build its own client: "a second
 * production instance would be a second policy waiting to drift from this one."
 *
 * The address rules, deadline, size cap and user agent that protect the
 * retrieval stage are exactly the ones that should protect this, so it imports
 * the shared client and accepts loading the config that comes with it. The
 * consequence is real and worth stating: **the probe job must be given the
 * service's environment**, including an upstream vendor key it never calls.
 * Policy drift on an SSRF boundary is the worse of the two problems.
 */

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	logger.error("DATABASE_URL is required to probe manifests");
	process.exit(1);
}

/** Domains per run. Bounded so one execution cannot run for an hour. */
const BATCH = Number(process.env.PROBE_BATCH ?? "200");

/**
 * Concurrent probes.
 *
 * Lower than the page-fetch pool: this walks a list of unrelated strangers'
 * hosts in sequence, and a crawler that opens a burst of connections across
 * many domains at once is the traffic shape that earns a block.
 */
const CONCURRENCY = Number(process.env.PROBE_CONCURRENCY ?? "4");

async function main(): Promise<void> {
	const pool = new Pool({ connectionString: databaseUrl, max: 2 });
	const store = new CapabilityStore(pool);

	try {
		const due = await store.due(BATCH);
		if (due.length === 0) {
			logger.info("no domains due for a manifest probe");
			return;
		}

		const counts: Record<string, number> = {};
		let next = 0;

		const worker = async (): Promise<void> => {
			while (true) {
				const index = next;
				next += 1;
				const site = due[index];
				if (!site) return;

				const probe = await probeManifest(site.domain, egress, site.etag);
				await store.record(site.domain, probe);
				counts[probe.state] = (counts[probe.state] ?? 0) + 1;

				if (probe.state === "valid") {
					logger.info(
						{ domain: site.domain, capabilities: probe.capabilities.length },
						"manifest read",
					);
				}
			}
		};

		await Promise.all(
			Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker),
		);

		// `absent` dominating is the expected shape of the web, not a problem.
		logger.info({ probed: due.length, ...counts }, "manifest probe complete");
	} finally {
		await pool.end();
	}
}

main().catch((error: unknown) => {
	logger.error(
		{ error: error instanceof Error ? error.message : String(error) },
		"manifest probe failed",
	);
	process.exit(1);
});
