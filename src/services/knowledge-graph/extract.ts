import type { TextModel } from "../../infra/model/index.js";
import { config } from "../../shared/config.js";
import { logger } from "../../shared/logger.js";
import { EDGE_TYPES, NODE_TYPES } from "./index.js";

/**
 * Named-entity and relation extraction: steps 7 and 10 of the indexing
 * pipeline.
 *
 * ### Why a model and not a NER library
 *
 * The specification's pipeline is NER → entity linking → relation extraction →
 * confidence → insertion. A classical NER model does the first step well and
 * none of the others; relation extraction in particular is the step that
 * produces `Larry Page → founded → Google`, and there is no small library that
 * does it usefully on arbitrary web prose. One model call does all four badly
 * but coherently, which is the right shape for a first version: the alternative
 * is a good entity list with no edges, and the edges are the asset.
 *
 * It runs in the worker, never on the request path, so its latency is nobody's
 * problem and its cost is one call per indexed document rather than per query.
 *
 * ### Every confidence here is capped
 *
 * A model's stated confidence is not evidence. What makes an edge trustworthy in
 * this system is being asserted by several documents — `graph.edges` accumulates
 * toward 1 across observations — so a single extraction is deliberately not
 * allowed to claim more than `MAX_SINGLE_OBSERVATION`, however sure it sounds.
 * Otherwise one confidently wrong page becomes a fact.
 */

export type ExtractedEntity = {
	name: string;
	type: string;
	confidence: number;
};

export type ExtractedEdge = {
	source: string;
	relation: string;
	target: string;
	confidence: number;
};

export type Extraction = {
	entities: ExtractedEntity[];
	edges: ExtractedEdge[];
};

/**
 * The ceiling on what one document may assert.
 *
 * 0.6 rather than 0.9: it is enough to rank on and not enough to state as fact,
 * and two independent documents agreeing pushes it to 0.84 through the
 * accumulation in `graph.edges`. That is the number that should feel like
 * knowledge, not this one.
 */
export const MAX_SINGLE_OBSERVATION = 0.6;

/** Bounded so a long document does not become a long prompt. */
const MAX_INPUT_CHARS = 6000;

const SYSTEM = `You extract entities and relationships from a web page.

Reply with two sections and nothing else:

ENTITIES
name | type | confidence

EDGES
source | relation | target | confidence

Types must be one of: ${NODE_TYPES.join(", ")}
Relations must be one of: ${EDGE_TYPES.join(", ")}

Rules:
- Only entities the page is actually about. Not every proper noun it mentions,
  and never the publisher, the site name, or a cookie vendor.
- Use the full canonical name: "PlayStation 5", not "PS5"; "Sony Interactive
  Entertainment", not "Sony" — unless the page only ever uses the short form.
- An edge's source and target must both appear in your ENTITIES list.
- Extract only relationships the page states. Do not add ones you happen to
  know; a relationship you supplied from memory cannot be checked against the
  page and will be indexed as though it could.
- confidence is 0.0 to 1.0 and reflects how clearly the page states it.
- If the page states nothing extractable, reply with both headers and no rows.`;

function parseRow(line: string, columns: number): string[] | null {
	const parts = line.split("|").map((part) => part.trim());
	if (parts.length !== columns) return null;
	if (parts.some((part) => part.length === 0)) return null;
	return parts;
}

function confidenceOf(raw: string): number {
	const value = Number(raw);
	if (!Number.isFinite(value)) return 0.3;
	return Math.min(MAX_SINGLE_OBSERVATION, Math.max(0, value));
}

export function parseExtraction(reply: string): Extraction {
	const entities: ExtractedEntity[] = [];
	const edges: ExtractedEdge[] = [];
	const types = new Set<string>(NODE_TYPES);
	const relations = new Set<string>(EDGE_TYPES);

	let section: "entities" | "edges" | null = null;

	for (const raw of reply.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;

		const heading = line.toUpperCase().replace(/[^A-Z]/g, "");
		if (heading === "ENTITIES") {
			section = "entities";
			continue;
		}
		if (heading === "EDGES") {
			section = "edges";
			continue;
		}
		// The header row, when the model repeats it back.
		if (/^name\s*\|/i.test(line) || /^source\s*\|/i.test(line)) continue;

		if (section === "entities") {
			const parts = parseRow(line, 3);
			if (!parts) continue;
			const [name, type, confidence] = parts;
			// A type outside the taxonomy is dropped rather than coerced. Coercing
			// it to "related_to"'s equivalent would put a guess in the graph under
			// a label that reads as a finding.
			if (!types.has(type)) continue;
			if (name.length > 200) continue;
			entities.push({ name, type, confidence: confidenceOf(confidence) });
			continue;
		}

		if (section === "edges") {
			const parts = parseRow(line, 4);
			if (!parts) continue;
			const [source, relation, target, confidence] = parts;
			if (!relations.has(relation)) continue;
			if (source === target) continue;
			edges.push({
				source,
				relation,
				target,
				confidence: confidenceOf(confidence),
			});
		}
	}

	// An edge whose ends are not both in the entity list cannot be inserted —
	// `graph.edges` has foreign keys to `graph.entities` — so it is dropped here
	// rather than failing later as a constraint violation in the worker's log.
	const known = new Set(entities.map((entity) => entity.name.toLowerCase()));
	const connected = edges.filter(
		(edge) =>
			known.has(edge.source.toLowerCase()) &&
			known.has(edge.target.toLowerCase()),
	);

	return {
		entities: entities.slice(0, 24),
		edges: connected.slice(0, 32),
	};
}

export type ExtractorDeps = { model: TextModel };

export function createExtractor(deps: ExtractorDeps) {
	return {
		async extract(
			text: string,
			title: string,
			signal?: AbortSignal,
		): Promise<Extraction> {
			if (text.trim().length < 200) return { entities: [], edges: [] };

			try {
				const reply = await deps.model.complete({
					system: SYSTEM,
					// Fenced and labelled as data. This is page text from the open
					// web, so it is text an adversary can write; the request carries
					// no tools, so the worst an injected instruction achieves is a
					// bad entity list.
					user: `<page title="${title.slice(0, 200)}">\n${text.slice(0, MAX_INPUT_CHARS)}\n</page>`,
					model: config.EVOLUTION_MODEL,
					maxTokens: 700,
					temperature: 0,
					signal,
				});

				return parseExtraction(reply);
			} catch (error) {
				// A document indexed without entities is still a searchable
				// document. Failing the index because extraction failed would
				// trade a usable result for none.
				logger.warn(
					{ error: (error as Error).message },
					"entity extraction failed; indexing without entities",
				);
				return { entities: [], edges: [] };
			}
		},
	};
}

export type Extractor = ReturnType<typeof createExtractor>;
