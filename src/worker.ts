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
 * A separate process on a separate Cloud Run service with `min-instances=1`,
 * because a Redis Streams consumer on a scale-to-zero service is a consumer
 * that is usually not running.
 *
 * What it does is everything the user must not wait for: fetching and indexing
 * the pages external providers returned, and folding extracted entities into
 * the graph. The request path publishes; this consumes.
 */

const GROUP = "indexer";
const CONSUMER = process.env.K_REVISION ?? `worker-${process.pid}`;

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

	logger.info({ consumer: CONSUMER, streams }, "worker started");

	while (running) {
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
