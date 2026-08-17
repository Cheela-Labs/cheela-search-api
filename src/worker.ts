import { STREAMS } from "./contracts/events.js";
import { pool } from "./infra/db/pool.js";
import { egress } from "./infra/egress/index.js";
import {
	acknowledge,
	consume,
	createBlockingClient,
	ensureGroup,
} from "./infra/redis/index.js";
import { vespa } from "./infra/vespa/client.js";
import { createIndexer } from "./services/indexer/index.js";
import { createGraph, entityId } from "./services/knowledge-graph/index.js";
import { logger } from "./shared/logger.js";
import { startTelemetry } from "./shared/telemetry.js";

/**
 * The event consumer.
 *
 * A separate process from the one that serves requests, running everything the
 * user must not wait for: fetching and indexing the pages external providers
 * returned, and folding extracted entities into the graph. The request path
 * publishes; this consumes.
 *
 * Deployed as a Cloud Run *Job* on a schedule rather than a service — see
 * `DRAIN_MS` for why, and for the one number that decision turns on.
 */

const GROUP = "indexer";
const CONSUMER = process.env.K_REVISION ?? `worker-${process.pid}`;

/**
 * How long to work before exiting, or 0 to run forever.
 *
 * This is what lets one binary be both a long-running service and a scheduled
 * Job, and the Job is what it actually runs as. A Cloud Run service that
 * consumes a stream needs CPU allocated between requests, and always-allocated
 * CPU is roughly $46/month for one vCPU — against a few dollars for a Job that
 * wakes every five minutes, drains the backlog and exits.
 *
 * The trade is indexing latency: a page a query discovered is indexed within
 * minutes rather than seconds. That is explicitly acceptable — the user never
 * waits for indexing — and it is the cheapest place in this system to spend
 * time. Set to 0 and deploy this as a service if that ever stops being true.
 */
const DRAIN_MS = Number(process.env.WORKER_DRAIN_MS ?? 0);

const indexer = createIndexer({ pool, vespa, egress });
const graph = createGraph({ pool });

let running = true;

async function handleSearchExecuted(urls: string[]): Promise<void> {
	// Sequential, deliberately. This is background work competing with live
	// queries for the same Vespa node, and a burst of parallel feeds is how a
	// background job becomes a latency incident on the request path.
	for (const url of urls.slice(0, 10)) {
		if (!running) return;
		try {
			const outcome = await indexer.index({ url });
			logger.debug({ url, outcome: outcome.status }, "indexed");
		} catch (error) {
			logger.warn({ url, error: (error as Error).message }, "index failed");
		}
	}
}

async function handleEntities(
	docId: string,
	entities: { name: string; type: string; confidence: number }[],
	edges: {
		source: string;
		relation: string;
		target: string;
		confidence: number;
	}[],
): Promise<void> {
	const ids: { id: string; confidence: number }[] = [];
	for (const entity of entities) {
		const id = await graph.upsertEntity(entity);
		ids.push({ id, confidence: entity.confidence });
	}
	await graph.recordMention(docId, ids);

	for (const edge of edges) {
		// Both ends must exist before the edge can reference them, and the
		// extractor emits names rather than ids.
		await graph
			.upsertEdge({
				source: entityId(edge.source, "Organization"),
				relation: edge.relation,
				target: entityId(edge.target, "Organization"),
				confidence: edge.confidence,
			})
			.catch((error) => {
				// A foreign-key failure here means one end was never created,
				// which is a bad extraction rather than a broken graph.
				logger.debug({ error: (error as Error).message, edge }, "edge skipped");
			});
	}
}

async function main(): Promise<void> {
	await startTelemetry();
	const client = createBlockingClient();
	const streams = [STREAMS.search, STREAMS.index, STREAMS.graph, STREAMS.crawl];

	for (const stream of streams) {
		await ensureGroup(stream, GROUP, client);
	}

	logger.info(
		{ consumer: CONSUMER, streams, drainMs: DRAIN_MS },
		"worker started",
	);

	const deadline =
		DRAIN_MS > 0 ? Date.now() + DRAIN_MS : Number.POSITIVE_INFINITY;

	while (running) {
		if (Date.now() >= deadline) {
			logger.info("drain budget spent; exiting");
			break;
		}
		let handledThisPass = 0;

		for (const stream of streams) {
			if (!running) break;
			let deliveries: Awaited<ReturnType<typeof consume>>;
			try {
				deliveries = await consume(stream, GROUP, CONSUMER, client, {
					count: 8,
					blockMs: 2000,
				});
			} catch (error) {
				logger.warn(
					{ stream, error: (error as Error).message },
					"stream read failed",
				);
				await new Promise((resolve) => setTimeout(resolve, 2000));
				continue;
			}

			const done: string[] = [];
			for (const delivery of deliveries) {
				if (!delivery.result.ok) {
					// Acknowledged even though it was rejected. An entry that is
					// never acknowledged is redelivered forever and blocks the
					// group's pending list behind it — so a single forged or
					// corrupt message would stop indexing entirely.
					logger.warn(
						{ stream, id: delivery.id, reason: delivery.result.reason },
						"rejected event",
					);
					done.push(delivery.id);
					continue;
				}

				const event = delivery.result.event;
				try {
					if (event.type === "SearchExecuted") {
						await handleSearchExecuted(event.resultUrls);
					} else if (event.type === "ExternalFetched") {
						await handleSearchExecuted(event.urls);
					} else if (event.type === "EntitiesExtracted") {
						await handleEntities(event.docId, event.entities, event.edges);
					}
					done.push(delivery.id);
				} catch (error) {
					logger.error(
						{ stream, id: delivery.id, error: (error as Error).message },
						"event handler failed",
					);
					// Not acknowledged: it stays pending and is retried by
					// whichever consumer claims it next.
				}
			}

			await acknowledge(stream, GROUP, done, client).catch(() => {});
			handledThisPass += deliveries.length;
		}

		// A full pass across every stream with nothing to do means the backlog is
		// gone. As a Job that is the signal to exit and stop billing; as a
		// service DRAIN_MS is zero and it keeps blocking on the next read.
		if (DRAIN_MS > 0 && handledThisPass === 0) {
			logger.info("streams are empty; exiting");
			break;
		}
	}

	await client.quit().catch(() => {});
}

function stop(signal: string): void {
	logger.info({ signal }, "worker stopping");
	running = false;
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

main().catch((error) => {
	logger.error(
		{ error: error instanceof Error ? error.message : error },
		"worker died",
	);
	process.exit(1);
});
