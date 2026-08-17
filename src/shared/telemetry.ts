import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
	BatchSpanProcessor,
	NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node";
import {
	ATTR_SERVICE_NAME,
	ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * OpenTelemetry tracing, as the TDS's observability section asks for.
 *
 * The reason it is worth the dependency here rather than a timer and a log
 * line: a search request fans out into a classifier call, several retrieval
 * hypotheses, an external provider or two, a rerank and a generation, some of
 * them concurrent. "The request took 1.8 seconds" is not a debuggable fact.
 * "The request took 1.8 seconds, 1.2 of which was one provider that later
 * timed out" is, and it is only visible as a span tree.
 *
 * Off unless `OTEL_ENABLED` and a project are set. There is no collector in
 * development and an exporter that cannot reach one retries in the background
 * for the life of the process.
 */

const TRACER_NAME = "cheela-search-api";

let provider: NodeTracerProvider | null = null;

export async function startTelemetry(): Promise<void> {
	if (!config.OTEL_ENABLED || !config.GCP_PROJECT_ID) return;

	try {
		// Imported lazily so a checkout without GCP credentials — every
		// development machine — never loads the exporter at all.
		const { TraceExporter } = await import(
			"@google-cloud/opentelemetry-cloud-trace-exporter"
		);

		provider = new NodeTracerProvider({
			resource: resourceFromAttributes({
				[ATTR_SERVICE_NAME]: "search-api",
				[ATTR_SERVICE_VERSION]: process.env.K_REVISION ?? "dev",
			}),
			spanProcessors: [
				new BatchSpanProcessor(
					new TraceExporter({ projectId: config.GCP_PROJECT_ID }),
				),
			],
		});
		provider.register();
		logger.info("tracing enabled");
	} catch (error) {
		// Telemetry must never be the reason a search engine will not boot.
		logger.warn({ error }, "tracing could not start; continuing without it");
	}
}

export async function stopTelemetry(): Promise<void> {
	await provider?.shutdown().catch(() => {});
}

/**
 * Runs `work` inside a span.
 *
 * When tracing is off this is a no-op wrapper — the OTel API's default
 * tracer returns non-recording spans — so call sites do not have to branch on
 * whether telemetry is enabled.
 */
export async function traced<T>(
	name: string,
	work: (span: Span) => Promise<T>,
	attributes: Record<string, string | number | boolean> = {},
): Promise<T> {
	const tracer = trace.getTracer(TRACER_NAME);
	return tracer.startActiveSpan(name, async (span) => {
		span.setAttributes(attributes);
		try {
			return await work(span);
		} catch (error) {
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: error instanceof Error ? error.message : String(error),
			});
			throw error;
		} finally {
			span.end();
		}
	});
}
