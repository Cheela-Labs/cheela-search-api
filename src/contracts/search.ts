import { z } from "zod";
import type { Comparison } from "../services/generator/index.js";
import type { StructuredNode } from "../services/structured/index.js";
import { type Intent, intentSchema } from "./intent.js";

/**
 * The `/search` wire contract.
 *
 * `apps/search-web` consumes exactly this. The TDS fixes the request and the
 * five response keys; it leaves `results[]`, `capabilities[]` and
 * `citations[]` as empty arrays with no shape, so those are defined here.
 *
 * Everything beyond the TDS's five keys is additive and documented as such at
 * its declaration. A consumer written against the TDS alone still works.
 */

/** Longer than any sensible question, short enough to bound what reaches a model. */
export const MAX_QUERY = 400;

export const searchRequestSchema = z.object({
	query: z.string().trim().min(1).max(MAX_QUERY),
	/**
	 * Optional in the TDS, and optional here — but a request without one gets
	 * a fresh session id back rather than no session, because the Context
	 * Engine cannot detect a follow-up to a conversation it was never told
	 * about. The client should send back what it was given.
	 */
	sessionId: z.string().trim().min(1).max(128).optional(),
	userId: z.string().trim().min(1).max(128).optional(),
});

export type SearchRequest = z.infer<typeof searchRequestSchema>;

export type Passage = {
	id: string;
	text: string;
	/** Whether the answer actually cited this passage, not whether it could. */
	cited: boolean;
};

export type CapabilityRef = {
	domain: string;
	invocationName: string;
	effects:
		| "read"
		| "write-reversible"
		| "write-irreversible"
		| "financial"
		| "unknown";
	/**
	 * Ours to decide, never the manifest's. A transport we do not speak, or an
	 * effects tier above `read`, is still indexed and still shown; it simply
	 * cannot be invoked from here.
	 */
	callable: boolean;
};

export type Result = {
	id: string;
	url: string;
	domain: string;
	path: string;
	title: string;
	snippet: string;
	/** The page's own og:image when it declares one. Frequently absent. */
	image?: string;
	authority: number;
	freshness: number;
	publishedAt?: number;
	/** A stable colour derived from the domain, so the surface need not pick one. */
	swatch: string;
	passages: Passage[];
	capabilities?: CapabilityRef[];
	/** Which retrieval path produced this — for debugging and for the eval harness. */
	source: "index" | "external";
	/**
	 * Additive. What the page published about itself in JSON-LD, parsed,
	 * type-filtered and capped by `services/structured`.
	 *
	 * Absent means one of two things and the difference matters to a surface:
	 * either the page carried no markup we read, or this is an external result
	 * and we never fetched the page at all — `source` tells them apart.
	 *
	 * A publisher's claim about their own page, never a fact. Anything rendered
	 * from it belongs attributed to `domain`.
	 */
	structured?: StructuredNode[];
	/** Additive. The page's own `<meta name="description">`. */
	description?: string;
	/**
	 * Additive. H1-H6 in document order — the author's own outline of the page.
	 *
	 * Indexed since the schema was written and, like `jsonld`, never selected.
	 * It is the only structured thing most documentation pages publish: almost
	 * none carry `TechArticle` markup, and nearly all carry a heading per
	 * section.
	 */
	headings?: string[];
};

export type CapabilityHit = {
	id: string;
	domain: string;
	invocationName: string;
	title: string;
	description: string;
	provider: string;
	auth: string;
	effects: CapabilityRef["effects"];
	callable: boolean;
	score: number;
};

export type Citation = {
	/** The bracketed number in the answer text. 1-based. */
	n: number;
	resultId: string;
	url: string;
	title: string;
};

export type EntityRef = {
	id: string;
	name: string;
	type: string;
	aliases: string[];
	popularity: number;
	/**
	 * The graph's own one-line account of this thing.
	 *
	 * Additive, and the reason the surface can render a knowledge card at all:
	 * a name and a type describe nothing. Written by the crawler from the
	 * publisher's own `Organization`/`SoftwareApplication` markup, longest
	 * wins — see `knowledge-graph/store.ts`.
	 */
	description?: string;
	/** Apex form, `www.` stripped. Which domain officially speaks for this name. */
	officialDomain?: string;
	/** The homepage as the publisher writes it, scheme and all. */
	officialUrl?: string;
	faviconUrl?: string;
	/** schema.org `sameAs`: the publisher's own list of their other profiles. */
	sameAs?: string[];
};

export type SearchResponse = {
	// ---- The TDS's five keys ----------------------------------------------
	answer: string;
	results: Result[];
	capabilities: CapabilityHit[];
	citations: Citation[];
	/** Whether this query was read as continuing the previous one. */
	followUp: boolean;

	/**
	 * Additive. A side-by-side table, present only on a comparison query and
	 * only when the model returned one whose shape was intact.
	 *
	 * Composed from the sources rather than extracted from any one of them,
	 * which is why it is a separate key rather than another `Result` field: a
	 * surface has to be able to label it as our reading rather than as a
	 * publisher's claim.
	 */
	comparison?: Comparison;

	// ---- Additive, documented superset ------------------------------------

	/** The classification, exposed because the surface renders it. */
	intent: {
		intent: Intent;
		confidence: number;
		entities: string[];
		/**
		 * Additive. Where a navigational query resolved to, when the structural
		 * pass resolved it — a typed hostname, or a name the entity registry
		 * holds an official domain for.
		 */
		officialDomain?: string;
		officialUrl?: string;
	};
	/** The generator receives these, so the surface may have them too. */
	entities: EntityRef[];
	/** Echoed so a client that sent none can send this one back next time. */
	sessionId: string;
	meta: {
		latencyMs: number;
		/** Whether the index alone answered, or external providers were needed. */
		servedFrom: "index" | "external" | "mixed";
		/** The retrieval hypotheses the evolution engine produced. */
		hypotheses: string[];
		/**
		 * Named parts that failed without failing the request. A search that
		 * silently degrades is a search nobody can debug — if Tavily timed out
		 * or the reranker was skipped, it is written here.
		 */
		degraded: string[];
	};
};

export const indexDocumentSchema = z.object({
	url: z.string().url(),
	title: z.string().trim().min(1).max(500),
	body: z.string().trim().min(1),
	language: z.string().trim().min(2).max(16).default("en"),
	publishedAt: z.number().int().nonnegative().optional(),
	authority: z.number().min(0).max(1).optional(),
});

export type IndexDocumentRequest = z.infer<typeof indexDocumentSchema>;

export const registerCapabilitySchema = z.object({
	id: z.string().trim().min(1).max(200),
	title: z.string().trim().min(1).max(200),
	description: z.string().trim().min(1).max(2000),
	provider: z.string().trim().min(1).max(200),
	auth: z.string().trim().max(64).default("none"),
	domain: z.string().trim().min(1).max(253),
	invocationName: z.string().trim().min(1).max(200),
	transport: z.string().trim().max(64).default("https"),
	examples: z.array(z.string().trim().min(1).max(400)).max(32).default([]),
	intents: z.array(intentSchema).max(20).default([]),
});

export type RegisterCapabilityRequest = z.infer<
	typeof registerCapabilitySchema
>;

/**
 * A stable colour per domain, so every surface renders the same source the
 * same way without coordinating. Hash, not a palette lookup: a palette needs
 * an entry per domain and the web has more domains than that.
 */
export function swatchFor(domain: string): string {
	let hash = 0;
	for (let index = 0; index < domain.length; index += 1) {
		hash = (hash * 31 + domain.charCodeAt(index)) | 0;
	}
	return `hsl(${Math.abs(hash) % 360} 62% 58%)`;
}
