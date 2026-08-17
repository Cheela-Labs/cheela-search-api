import { randomUUID } from "node:crypto";
import type { Intent } from "../../contracts/intent.js";
import type { TextModel } from "../../infra/model/index.js";
import type { Cache } from "../../infra/redis/cache.js";
import { config } from "../../shared/config.js";
import { logger } from "../../shared/logger.js";

/**
 * The Context Engine.
 *
 * Decides whether a query continues the previous one, and if so rewrites it
 * into something that can be retrieved on its own:
 *
 *     Australian wildfire
 *     How many died?
 *       → How many people died in the 2019-20 Australian bushfire season?
 *
 * The rewrite is the point. "How many died?" retrieves nothing useful against
 * any index in the world, because the thing it is about is not in it.
 *
 * ### Detecting a follow-up before spending a model call on it
 *
 * The specifications list four signals: semantic similarity, shared entities,
 * pronouns, and session proximity. Three of those are computable locally and
 * are checked first, because rewriting is a model call inside the latency
 * budget and most queries are not follow-ups. The model is asked only when the
 * local signals already say it probably is one.
 */

export type Turn = {
	query: string;
	/** The query as retrieved — rewritten, if it was. */
	resolved: string;
	intent: Intent;
	entities: string[];
	at: number;
};

export type Session = {
	id: string;
	turns: Turn[];
};

/** Enough to resolve a reference; not a transcript. */
const MAX_TURNS = 6;

export type ContextVerdict = {
	sessionId: string;
	followUp: boolean;
	/** What to actually retrieve. Equals the input when it is not a follow-up. */
	resolved: string;
	session: Session;
};

const PRONOUNS =
	/\b(it|its|it's|they|them|their|there|he|him|his|she|her|hers|this|that|these|those|one|ones)\b/i;

/** A question with no subject of its own: "how many died?", "why?", "and then?" */
const ELLIPTICAL =
	/^\s*(and|but|so|what about|how about|why|when|where|who|how)\b/i;

const STOP = new Set([
	"the",
	"a",
	"an",
	"of",
	"in",
	"on",
	"at",
	"to",
	"for",
	"and",
	"or",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"how",
	"what",
	"why",
	"when",
	"where",
	"who",
	"which",
	"did",
	"do",
	"does",
	"many",
	"much",
]);

export function terms(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((word) => word.length > 2 && !STOP.has(word)),
	);
}

/** Jaccard overlap. Cheap, local, and good enough to gate a model call. */
export function overlap(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const item of a) if (b.has(item)) shared += 1;
	return shared / (a.size + b.size - shared);
}

export type FollowUpSignals = {
	pronoun: boolean;
	elliptical: boolean;
	short: boolean;
	sharedEntities: number;
	similarity: number;
	recent: boolean;
};

export function signalsFor(
	query: string,
	previous: Turn,
	now: number,
	windowMs: number,
): FollowUpSignals {
	const queryTerms = terms(query);
	const previousTerms = terms(previous.resolved);
	const entities = new Set(
		previous.entities.map((entry) => entry.toLowerCase()),
	);

	let sharedEntities = 0;
	for (const entity of entities) {
		if (query.toLowerCase().includes(entity)) sharedEntities += 1;
	}

	return {
		pronoun: PRONOUNS.test(query),
		elliptical: ELLIPTICAL.test(query),
		short: query.trim().split(/\s+/).length <= 5,
		sharedEntities,
		similarity: overlap(queryTerms, previousTerms),
		recent: now - previous.at <= windowMs,
	};
}

/**
 * Whether these signals amount to a follow-up.
 *
 * Written as an explicit rule rather than a weighted score because the failure
 * modes are asymmetric and need to be reasoned about separately. Treating a
 * new question as a follow-up corrupts it with the previous topic and produces
 * a confidently irrelevant answer; missing a follow-up merely produces a
 * shallow one. So the rule demands recency plus at least one *referential*
 * signal — a pronoun, an ellipsis, or a named carry-over — and never fires on
 * similarity alone, which is high for any two queries about the same subject
 * including two independent ones.
 */
export function isFollowUp(signals: FollowUpSignals): boolean {
	if (!signals.recent) return false;

	const referential =
		signals.pronoun || signals.elliptical || signals.sharedEntities > 0;
	if (!referential) return false;

	// A pronoun or an ellipsis in a short query is close to conclusive: it is
	// a sentence that cannot stand up by itself.
	if ((signals.pronoun || signals.elliptical) && signals.short) return true;

	// Otherwise the topic has to actually match.
	return signals.sharedEntities > 0 || signals.similarity >= 0.2;
}

const SYSTEM = `You rewrite a follow-up search query so it can be understood alone.

You are given the previous queries in a session and the newest one. Reply with
the rewritten query on a single line and nothing else.

Rules:
- Replace pronouns and references with the thing they refer to.
- Keep it a search query, not a sentence addressed to anyone.
- Change nothing else. Do not add detail that was not implied, do not answer
  the question, and do not invent dates, places or numbers.
- If the newest query already stands alone, repeat it back unchanged.`;

export type ContextDeps = {
	model: TextModel;
	sessions: Cache<Session>;
};

export function createContext(deps: ContextDeps) {
	const ttlMs = config.SESSION_TTL_SECONDS * 1000;

	return {
		/**
		 * Loads the session, decides whether this query continues it, and
		 * resolves it if so.
		 */
		async resolve(
			query: string,
			sessionId: string | undefined,
			signal?: AbortSignal,
		): Promise<ContextVerdict> {
			const id = sessionId ?? randomUUID();
			// A session that has expired reads as absent, which is exactly the
			// TDS's "sessions expire after inactivity" — the TTL on the key is
			// the expiry, so there is no sweep to run and no clock to agree on.
			const session = (await deps.sessions.get(id)) ?? { id, turns: [] };
			const previous = session.turns.at(-1);

			if (!previous) {
				return { sessionId: id, followUp: false, resolved: query, session };
			}

			const signals = signalsFor(query, previous, Date.now(), ttlMs);
			if (!isFollowUp(signals)) {
				return { sessionId: id, followUp: false, resolved: query, session };
			}

			const history = session.turns
				.slice(-3)
				.map((turn) => `- ${turn.resolved}`)
				.join("\n");

			try {
				const rewritten = (
					await deps.model.complete({
						system: SYSTEM,
						user: `Previous queries:\n${history}\n\nNewest query: ${query}`,
						model: config.INTENT_MODEL,
						maxTokens: 80,
						temperature: 0,
						signal,
					})
				)
					.split(/\r?\n/)[0]
					.trim()
					.replace(/^["']|["']$/g, "");

				// A rewrite that came back empty, or absurdly long, is a failed
				// rewrite wearing a success's clothes.
				const usable =
					rewritten.length > 0 && rewritten.length <= 300 ? rewritten : query;

				return { sessionId: id, followUp: true, resolved: usable, session };
			} catch (error) {
				logger.warn(
					{ error: (error as Error).message },
					"follow-up rewrite failed; retrieving the query as typed",
				);
				// Still reported as a follow-up: the detection succeeded and the
				// caller should know, even though the rewrite did not.
				return { sessionId: id, followUp: true, resolved: query, session };
			}
		},

		/** Appends the turn and refreshes the inactivity window. */
		async record(session: Session, turn: Turn): Promise<void> {
			const turns = [...session.turns, turn].slice(-MAX_TURNS);
			await deps.sessions.put(session.id, { id: session.id, turns });
		},
	};
}

export type Context = ReturnType<typeof createContext>;
