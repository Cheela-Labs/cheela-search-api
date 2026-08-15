import { config } from "../../shared/config";
import { egress } from "../egress";
import { createAnySearchProvider } from "./anysearch";
import { createFanout, withSupplements } from "./fanout";
import { createGitHubProvider } from "./github";
import { createGoogleCseProvider } from "./google-cse";
import { createRotation } from "./rotation";
import { createTavilyProvider } from "./tavily";
import type { SearchProvider } from "./types";
import { createWikipediaProvider } from "./wikipedia";

export { createAnySearchProvider } from "./anysearch";
export { createFanout, withSupplements } from "./fanout";
export { createGitHubProvider } from "./github";
export { createGoogleCseProvider } from "./google-cse";
export {
	createRotation,
	type RotationResult,
	type SearchRotation,
} from "./rotation";
export { createTavilyProvider } from "./tavily";
export {
	type Candidate,
	DEFAULT_LIMIT,
	interleaveAll,
	normaliseCandidates,
	type SearchOptions,
	type SearchProvider,
	UpstreamError,
} from "./types";
export { createWikipediaProvider } from "./wikipedia";

/**
 * The process-wide rotation, built from whichever providers are configured.
 *
 * `SEARCH_PROVIDER_ORDER` decides the order, and the config schema refuses to
 * start unless at least one named provider has its credentials — so a
 * misconfigured deploy fails at boot with a message naming the variable, rather
 * than at the first query with an empty result set.
 */
function build(): SearchProvider[] {
	const available = new Map<string, () => SearchProvider>([
		[
			"tavily",
			() => createTavilyProvider(config.TAVILY_API_KEY as string, egress),
		],
		[
			"anysearch",
			() => createAnySearchProvider(config.ANYSEARCH_API_KEY as string, egress),
		],
		[
			"google-cse",
			() =>
				createGoogleCseProvider(
					config.GOOGLE_CSE_API_KEY as string,
					config.GOOGLE_CSE_ENGINE_ID as string,
					egress,
				),
		],
	]);

	const configured: Record<string, boolean> = {
		tavily: Boolean(config.TAVILY_API_KEY),
		anysearch: Boolean(config.ANYSEARCH_API_KEY),
		"google-cse": Boolean(
			config.GOOGLE_CSE_API_KEY && config.GOOGLE_CSE_ENGINE_ID,
		),
	};

	return config.SEARCH_PROVIDER_ORDER.filter(
		(name) => configured[name] && available.has(name),
	).map((name) => (available.get(name) as () => SearchProvider)());
}

/**
 * The free specialists, asked in parallel with the paid ones.
 *
 * Kept in a separate list from `build()` rather than as two more names in
 * `SEARCH_PROVIDER_ORDER`, because they are not interchangeable with a general
 * vendor and putting them in one list invites treating them as such. A rotation
 * that failed over from Tavily to Wikipedia would answer `cheap flights to goa`
 * with an encyclopedia article and call it a successful search.
 */
function buildSupplements(): SearchProvider[] {
	const available = new Map<string, () => SearchProvider>([
		["wikipedia", () => createWikipediaProvider(egress)],
		[
			"github",
			() => createGitHubProvider(config.GITHUB_TOKEN as string, egress),
		],
	]);

	// Wikipedia needs no credential; GitHub is useless without one. See
	// `GITHUB_TOKEN` in the config for why an unauthenticated GitHub is worse
	// than an absent one.
	const configured: Record<string, boolean> = {
		wikipedia: true,
		github: Boolean(config.GITHUB_TOKEN),
	};

	return config.SEARCH_SUPPLEMENTS.filter(
		(name) => configured[name] && available.has(name),
	).map((name) => (available.get(name) as () => SearchProvider)());
}

/**
 * The process-wide search, assembled in two layers.
 *
 * The paid vendors get whichever policy `SEARCH_PROVIDER_MODE` names — failover
 * by default, because the default must not be the expensive one. The free
 * specialists wrap that, always in parallel, because their cost is latency they
 * hide inside the primary's own and not money.
 */
const paid = build();

export const upstream = withSupplements(
	config.SEARCH_PROVIDER_MODE === "fanout"
		? createFanout(paid)
		: createRotation(paid),
	buildSupplements(),
);
