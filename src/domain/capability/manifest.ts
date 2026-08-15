import { createHash } from "node:crypto";

import {
	type AdpCapability,
	type AdpEndpoint,
	type AdpManifest,
	SPEC_VERSION,
	validateAdpManifest,
} from "@cheela/adp";

import type { EgressClient } from "../../infra/egress/client";
import { logger } from "../../shared/logger";

/**
 * Reading an ADS manifest published by a stranger.
 *
 * PLAN.md's rules for this are mostly about *not* being strict, and each one
 * exists because the alternative loses information we cannot recover without a
 * full re-crawl:
 *
 * - an unrecognised `transport` or `auth` does not remove a capability — we
 *   cannot call it, the site still does it, and the user should still be told;
 * - unknown fields and `extensions` are round-tripped verbatim;
 * - `description`, `inputSchema` and `outputSchema` are all optional, and the
 *   degenerate manifest — a name and a version — is the common case in
 *   hand-written files;
 * - a major `specVersion` ahead of ours stops the read rather than guessing;
 * - `404` is the normal outcome for most of the web and is never an alert.
 */

/** Where the spec says a manifest lives. */
export const MANIFEST_PATH = "/.well-known/agent-discovery.json";

export type ManifestProbe =
	| {
			state: "valid";
			url: string;
			raw: unknown;
			hash: string;
			specVersion: string | null;
			etag: string | null;
			capabilities: ReadCapability[];
	  }
	| {
			state: "invalid";
			url: string;
			raw: unknown;
			hash: string;
			specVersion: string | null;
			etag: string | null;
			errors: unknown;
	  }
	| { state: "absent" }
	| { state: "unreadable"; detail: string };

export type ReadCapability = {
	name: string;
	invocationName: string | null;
	version: string | null;
	description: string | null;
	transport: string | null;
	auth: string | null;
	address: string | null;
	effects: Effects;
	invocableByUs: boolean;
	deprecated: boolean;
	extensions: unknown;
};

export type Effects =
	| "read"
	| "write-reversible"
	| "write-irreversible"
	| "financial"
	| "unknown";

/** Transports we can actually speak. Anything else is indexed, not invocable. */
const SPOKEN_TRANSPORTS = new Set(["https", "http", "openapi", "mcp"]);

/**
 * The effects tier, derived from structure rather than from prose.
 *
 * **PLAN.md's invariant: manifest text can only lower a capability's privilege,
 * never raise it.** So this reads the verb in the name and the shape of the
 * call, and never the description — if a manifest describes `deleteAllRecords`
 * as "safely previews your data", our verdict stands and the mismatch is itself
 * a demotion signal rather than a reason to believe the prose.
 *
 * Deliberately coarse and deliberately pessimistic. `unknown` is not a failure
 * state; it is the honest answer for a name that tells us nothing, and it is
 * treated as untrusted everywhere downstream.
 */
export function effectsFor(capability: {
	name: string;
	invocationName?: string;
}): Effects {
	const subject = ` ${capability.name} ${capability.invocationName ?? ""} `
		.toLowerCase()
		.replace(/[._-]+/g, " ");

	/*
	  **Verbs, never nouns**, and this ordering is the correction that matters.

	  The first version led with a financial pattern that included `order`,
	  `payment` and `billing` — nouns naming the *domain* rather than the action.
	  Run against a real manifest it labelled `orders-get-order` and
	  `store-list-payment-methods` as financial. Both are reads. A chip that
	  warns about a payment on a capability that only lists them is a false alarm
	  that teaches people to ignore the true ones.

	  So: unambiguous destructive and financial verbs first, because those are
	  the ones worth being conservative about. Then read verbs, which settle a
	  name whose remaining words are only nouns. Then writes. Then `unknown`,
	  which is an honest answer and is treated as untrusted downstream — better
	  than a confident wrong tier in either direction.
	*/
	const has = (pattern: RegExp): boolean => pattern.test(subject);

	if (has(/ (pay|pays|charge|refund|purchase|checkout) /)) return "financial";

	if (has(/ (delete|destroy|remove|revoke|terminate|purge|wipe|clear|cancel) /))
		return "write-irreversible";

	// Before the write verbs: a name is frequently `noun-verb-noun`, and the
	// surrounding nouns must not outvote the verb in the middle.
	if (
		has(
			/ (get|list|find|search|read|lookup|query|fetch|show|view|check|describe|available|status) /,
		)
	)
		return "read";

	if (
		has(
			/ (create|update|book|schedule|move|send|post|put|patch|add|set|write|edit|place|submit) /,
		)
	)
		return "write-reversible";

	return "unknown";
}

function hashOf(raw: string): string {
	return createHash("sha256").update(raw).digest("hex");
}

/** The major component, so `0.3.0` and `0.9.1` compare as equal-major. */
function majorOf(version: string): number {
	return Number.parseInt(version.split(".")[0] ?? "", 10);
}

function readCapability(capability: AdpCapability): ReadCapability {
	/*
	  Read defensively even though these fields are typed required.

	  The type describes a manifest that validated; this function also runs on
	  the way to deciding whether one did, and on files written by hand by people
	  who have never read the schema. A `??` here costs nothing and is the
	  difference between skipping one malformed capability and throwing away the
	  whole site's manifest.
	*/
	const endpoint = capability.endpoint as Partial<AdpEndpoint> | undefined;
	const transport = endpoint?.transport ?? null;
	const auth = endpoint?.auth ?? null;
	// **Any non-empty string.** PLAN.md: "Do not expect Cheela's broker URL
	// pattern and do not treat its absence as a defect."
	const address =
		typeof endpoint?.address === "string" && endpoint.address.length > 0
			? endpoint.address
			: null;

	return {
		name: capability.name,
		// May be absent. Left null rather than invented when there is nothing to
		// derive it from.
		invocationName: capability.invocationName ?? null,
		version: capability.version ?? null,
		description: capability.description ?? null,
		transport,
		auth,
		address,
		effects: effectsFor({
			name: capability.name,
			invocationName: capability.invocationName,
		}),
		invocableByUs: transport !== null && SPOKEN_TRANSPORTS.has(transport),
		deprecated: Boolean(capability.deprecated),
		extensions: null,
	};
}

/**
 * Fetches and reads one domain's manifest.
 *
 * Through the same egress client every page fetch uses, so a manifest URL gets
 * the same address rules, deadline and size cap as anything else we pull off
 * the internet. A `/.well-known/` path on a stranger's host is not more trusted
 * than the rest of their site.
 */
/**
 * Reads a fetched body. Pure — no network, no policy.
 *
 * Split from `probeManifest` so the parsing rules can be tested directly. They
 * were not, at first, and the tests had to stand up an HTTP server that the
 * fetcher then correctly refused to talk to: manifests are fetched over
 * `https`, and a test should not have to defeat that to check how a field is
 * parsed.
 */
export function readManifest(
	body: string,
	url: string,
	etag: string | null = null,
): ManifestProbe {
	const hash = hashOf(body);

	let raw: unknown;
	try {
		raw = JSON.parse(body);
	} catch {
		// A `/.well-known/` path that answers 200 with HTML is a catch-all route,
		// not a manifest — and it is extremely common.
		return { state: "unreadable", detail: "not JSON" };
	}

	const specVersion =
		typeof (raw as { specVersion?: unknown })?.specVersion === "string"
			? (raw as { specVersion: string }).specVersion
			: null;

	// A major ahead of ours stops the read. Guessing at a spec we have not seen
	// is how a field gets silently misinterpreted rather than skipped.
	if (specVersion && majorOf(specVersion) > majorOf(SPEC_VERSION)) {
		logger.info(
			{ url, specVersion, ours: SPEC_VERSION },
			"Manifest declares a newer major spec version — not read",
		);
		return {
			state: "invalid",
			url,
			raw,
			hash,
			specVersion,
			etag,
			errors: [
				{ message: `specVersion ${specVersion} is ahead of ${SPEC_VERSION}` },
			],
		};
	}

	const result = validateAdpManifest(raw);
	if (!result.valid) {
		// Kept, not discarded. An invalid manifest is evidence about the spec in
		// the wild, and the row is what makes that measurable later.
		return {
			state: "invalid",
			url,
			raw,
			hash,
			specVersion,
			etag,
			errors: result.errors,
		};
	}

	const manifest = result.manifest as AdpManifest;
	return {
		state: "valid",
		url,
		raw,
		hash,
		specVersion,
		etag,
		capabilities: (manifest.capabilities ?? []).map(readCapability),
	};
}

/**
 * Fetches one domain's manifest and reads it.
 *
 * Through the same egress client every page fetch uses, so a manifest URL gets
 * the same address rules, deadline and size cap as anything else we pull off
 * the internet. A `/.well-known/` path on a stranger's host is not more trusted
 * than the rest of their site.
 *
 * **`https` only.** A manifest names endpoints and their auth; fetching that
 * over a channel anyone can rewrite would let a network attacker choose what a
 * site appears to offer.
 */
export async function probeManifest(
	domain: string,
	client: EgressClient,
	etag?: string | null,
): Promise<ManifestProbe> {
	const url = `https://${domain}${MANIFEST_PATH}`;

	let response: Awaited<ReturnType<EgressClient["fetch"]>>;
	try {
		response = await client.fetch(
			url,
			etag ? { headers: { "if-none-match": etag } } : undefined,
		);
	} catch (error) {
		return {
			state: "unreadable",
			detail: error instanceof Error ? error.message : String(error),
		};
	}

	// Unchanged. The caller keeps what it has and pushes the next probe out.
	if (response.status === 304) return { state: "absent" };

	// The normal outcome for most of the web, and never an alert.
	if (response.status === 404 || response.status === 410) {
		return { state: "absent" };
	}

	if (response.status >= 400) {
		return { state: "unreadable", detail: `status ${response.status}` };
	}

	return readManifest(
		response.body.toString("utf8"),
		url,
		response.headers.etag ?? null,
	);
}
