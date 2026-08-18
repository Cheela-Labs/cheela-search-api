import { domainOf, STREAMS } from "@cheela/search-core";
import { pool } from "./infra/db/pool.js";
import {
	acknowledge,
	consume,
	createBlockingClient,
	ensureGroup,
} from "./infra/redis/index.js";
import { vespa } from "./infra/vespa/client.js";
import {
	claim,
	complete,
	enqueue,
	recordQuery,
} from "./services/crawler/index.js";
import { priorAuthority } from "./services/indexer/index.js";
import { entityId } from "./services/knowledge-graph/index.js";
import { createIndexStage } from "./services/retriever/vespa-stage.js";
import { logger } from "./shared/logger.js";
import { startTelemetry } from "./shared/telemetry.js";
import { buildGraph, buildIndexer } from "./wiring.js";

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

// From wiring.ts, not assembled here. See buildIndexer's comment: a second
// wiring is how this process ended up indexing without archiving or
// extracting anything, for weeks, while its tests passed.
const indexer = buildIndexer();
const graph = buildGraph();
// Read on the request path, written here: the same module owns both halves of
// query memory so they cannot disagree about the key.
const index = createIndexStage(vespa);

let running = true;

/** How many URLs one event may index inline before the rest are deferred. */
const INLINE_BUDGET = 10;

async function handleSearchExecuted(urls: string[]): Promise<void> {
	// Anything past the budget goes to the frontier rather than being dropped.
	//
	// This is also what puts anything in the frontier at all: the crawl scheduler
	// ranks and promotes rows, and until this existed it ranked an empty table
	// hourly. A URL a real query surfaced is the best demand signal there is, so
	// deferring it is scheduling rather than discarding.
	const deferred = urls.slice(INLINE_BUDGET);
	if (deferred.length > 0) {
		await enqueue(
			pool,
			deferred.flatMap((url) => {
				const domain = domainOf(url);
				return domain ? [{ url, domain, authority: priorAuthority(url) }] : [];
			}),
		).catch((error) => {
			logger.warn(
				{ error: (error as Error).message },
				"could not defer urls to the frontier",
			);
		});
	}

	// Sequential, deliberately. This is background work competing with live
	// queries for the same Vespa node, and a burst of parallel feeds is how a
	// background job becomes a latency incident on the request path.
	for (const url of urls.slice(0, INLINE_BUDGET)) {
		if (!running) return;
		try {
			const outcome = await indexer.index({ url });
			logger.debug({ url, outcome: outcome.status }, "indexed");

			// A transport failure is worth retrying later; a refusal is not.
			// `robots-disallowed` and `javascript-shell` return the same answer
			// however many times they are asked, and requeueing them is how a
			// frontier fills with work that can never succeed.
			if (outcome.status === "failed") {
				const domain = domainOf(url);
				if (domain) {
					await enqueue(pool, [
						{ url, domain, authority: priorAuthority(url) },
					]).catch(() => {});
				}
			}
		} catch (error) {
			logger.warn({ url, error: (error as Error).message }, "index failed");
		}
	}
}

/** How many frontier URLs one pass may take. Bounded so the streams stay live. */
const FRONTIER_BATCH = 10;

/**
 * Indexes work the crawl scheduler promoted.
 *
 * `plan` moves rows `pending → queued` and, until this existed, nothing moved
 * them any further: the scheduler ran hourly and promoted into a void.
 */
async function drainFrontier(): Promise<number> {
	let claimed: Awaited<ReturnType<typeof claim>>;
	try {
		claimed = await claim(pool, FRONTIER_BATCH);
	} catch (error) {
		logger.warn(
			{ error: (error as Error).message },
			"could not claim frontier work",
		);
		return 0;
	}

	for (const entry of claimed) {
		if (!running) break;
		try {
			const outcome = await indexer.index({ url: entry.url });
			await complete(
				pool,
				entry.url,
				outcome.status,
				"reason" in outcome ? outcome.reason : "",
			);
			logger.debug(
				{ url: entry.url, outcome: outcome.status },
				"frontier indexed",
			);
		} catch (error) {
			await complete(pool, entry.url, "failed", (error as Error).message).catch(
				() => {},
			);
		}
	}

	return claimed.length;
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

	// The extractor emits edges by *name*; ids are derived from name and type
	// together. Looking the type up from the same extraction is the whole fix
	// for a bug that silently dropped most edges: both endpoints used to be
	// resolved as `entityId(name, "Organization")`, so any edge touching a
	// Person, Product, Place, Event or Technology computed an id that was never
	// inserted, violated its foreign key, and was logged at debug as "skipped".
	// `Larry Page → founded → Google` — the specification's own example — failed
	// on the source every time.
	const typeOf = new Map(
		entities.map((entity) => [entity.name.toLowerCase(), entity.type]),
	);

	for (const edge of edges) {
		const sourceType = typeOf.get(edge.source.toLowerCase());
		const targetType = typeOf.get(edge.target.toLowerCase());
		// parseExtraction already drops edges whose ends are not both in the
		// entity list, so this is a belt-and-braces guard rather than a filter.
		if (!sourceType || !targetType) continue;

		await graph
			.upsertEdge({
				source: entityId(edge.source, sourceType),
				relation: edge.relation,
				target: entityId(edge.target, targetType),
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
						// The demand signal first: it is one INSERT and it is what the
						// crawl scheduler ranks on. Indexing the URLs can fail; the
						// record of what was asked should not be lost with it.
						await recordQuery(pool, {
							normalizedQuery: event.normalizedQuery,
							intent: event.intent,
							resultDomains: [
								...new Set(event.resultUrls.map(domainOf).filter(Boolean)),
							],
							servedFrom: event.servedFrom,
						}).catch((error) => {
							logger.warn(
								{ error: (error as Error).message },
								"could not record the query log",
							);
						});
						// And into query_memory, which the evolution engine reads on
						// the next search for this question.
						await index
							.remember({
								query: event.query,
								normalizedQuery: event.normalizedQuery,
								hypotheses: event.hypotheses,
								intent: event.intent,
								resultUrls: event.resultUrls,
							})
							.catch((error) => {
								logger.warn(
									{ error: (error as Error).message },
									"could not write query memory",
								);
							});
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

		// With the streams quiet, spend what is left of the budget on the
		// frontier. Events first, deliberately: a URL a query just produced is
		// worth more than one the scheduler promoted an hour ago, and the
		// frontier is the backlog rather than the live signal.
		const crawled = await drainFrontier();
		handledThisPass += crawled;

		// A full pass across every stream and the frontier with nothing to do
		// means the backlog is gone. As a Job that is the signal to exit and stop
		// billing; as a service DRAIN_MS is zero and it keeps blocking.
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
