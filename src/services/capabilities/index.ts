import type { VespaClient } from "@cheela/search-core";
import { envelope, STREAMS } from "@cheela/search-core";
import type pg from "pg";
import type {
	CapabilityRef,
	RegisterCapabilityRequest,
} from "../../contracts/search.js";
import { publish } from "../../infra/redis/streams.js";
import { logger } from "../../shared/logger.js";

/**
 * The Capability Registry.
 *
 * Capabilities are indexed exactly like documents, into a Vespa schema with
 * the same rank profile, so they compete with web pages rather than being
 * appended to them.
 *
 * ### Effects are ours to decide
 *
 * `effects` and `callable` are derived here from the invocation name's verb,
 * never read from what the publisher wrote. A manifest that labels a payment
 * as `read` does not make it one, and the whole value of the tier is that it
 * is a claim *we* stand behind. The rule is one-directional: what a publisher
 * says can only ever lower privilege, never raise it.
 */

export type Effects = CapabilityRef["effects"];

const VERB_EFFECTS: [RegExp, Effects][] = [
	// Ordered by severity. First match wins, so a "refund" is financial even
	// though it also matches "update".
	[
		/\b(pay|purchase|buy|charge|refund|transfer|invoice|checkout|order)\b/i,
		"financial",
	],
	[
		/\b(delete|remove|destroy|cancel|revoke|terminate|send|publish|post|submit)\b/i,
		"write-irreversible",
	],
	[
		/\b(create|add|update|edit|set|schedule|book|reserve|move|rename|assign)\b/i,
		"write-reversible",
	],
	[
		/\b(get|list|read|search|find|lookup|show|fetch|check|view|query)\b/i,
		"read",
	],
];

export function effectsFor(invocationName: string, title = ""): Effects {
	const text = `${invocationName.replace(/[._-]/g, " ")} ${title}`;
	for (const [pattern, effects] of VERB_EFFECTS) {
		if (pattern.test(text)) return effects;
	}
	// Unknown is not "probably safe". It ranks and displays; it is not callable.
	return "unknown";
}

const SPOKEN_TRANSPORTS = new Set(["https", "http", "openapi", "mcp"]);

export function callableByUs(transport: string, effects: Effects): boolean {
	// Read-only, over a transport we speak. Everything above `read` needs the
	// consent path that does not exist yet, and a transport we cannot speak
	// cannot be invoked whatever its tier.
	return SPOKEN_TRANSPORTS.has(transport.toLowerCase()) && effects === "read";
}

/**
 * The phrases a capability is matched on.
 *
 * The identifier is deliberately excluded. "calendar.add_event" embeds as an
 * identifier rather than as an intention, and including it dilutes every
 * phrase that was written to be matched by a person's words.
 */
export function intentPhrases(
	capability: Pick<
		RegisterCapabilityRequest,
		"title" | "description" | "examples" | "provider"
	>,
): string[] {
	return [
		capability.title,
		capability.description,
		`${capability.title} with ${capability.provider}`,
		...capability.examples,
	]
		.map((entry) => entry.trim())
		.filter(Boolean)
		.slice(0, 15);
}

export type CapabilityDeps = {
	pool: pg.Pool;
	vespa: VespaClient;
};

export function createCapabilities(deps: CapabilityDeps) {
	return {
		async register(input: RegisterCapabilityRequest): Promise<{
			id: string;
			effects: Effects;
			callable: boolean;
		}> {
			const effects = effectsFor(input.invocationName, input.title);
			const callable = callableByUs(input.transport, effects);
			const phrases = intentPhrases(input);

			await deps.pool.query(
				`INSERT INTO capability.sites (domain, discovery_method, state)
				 VALUES ($1, 'registered', 'valid')
				 ON CONFLICT (domain) DO UPDATE SET last_probed_at = now()`,
				[input.domain],
			);

			await deps.pool.query(
				`INSERT INTO capability.capabilities
				   (cap_id, domain, invocation_name, title, description, provider,
				    auth, transport, effects, callable, examples, intents)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
				 ON CONFLICT (cap_id) DO UPDATE SET
				   title = EXCLUDED.title,
				   description = EXCLUDED.description,
				   provider = EXCLUDED.provider,
				   auth = EXCLUDED.auth,
				   transport = EXCLUDED.transport,
				   effects = EXCLUDED.effects,
				   callable = EXCLUDED.callable,
				   examples = EXCLUDED.examples,
				   intents = EXCLUDED.intents,
				   updated_at = now()`,
				[
					input.id,
					input.domain,
					input.invocationName,
					input.title,
					input.description,
					input.provider,
					input.auth,
					input.transport,
					effects,
					callable,
					input.examples,
					input.intents,
				],
			);

			const intentWeights: Record<string, number> = {};
			for (const intent of input.intents) intentWeights[intent] = 1;

			await deps.vespa.put("capability", input.id, {
				cap_id: input.id,
				domain: input.domain,
				invocation_name: input.invocationName,
				title: input.title,
				description: input.description,
				provider: input.provider,
				auth: input.auth,
				transport: input.transport,
				effects,
				callable,
				examples: input.examples,
				intent_phrases: phrases,
				intent_weights: intentWeights,
				intents: input.intents,
				popularity: 0,
				indexed_at: Math.floor(Date.now() / 1000),
			});

			void publish(
				STREAMS.search,
				envelope({
					type: "CapabilityRegistered" as const,
					capId: input.id,
					domain: input.domain,
					invocationName: input.invocationName,
				}),
			);

			return { id: input.id, effects, callable };
		},

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
						effects: row.effects as Effects,
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
