import { config } from "../../shared/config";
import { egress } from "../egress";
import { createGoogleCseProvider } from "./google-cse";
import { createRotation } from "./rotation";
import { createTavilyProvider } from "./tavily";
import type { SearchProvider } from "./types";

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
	normaliseCandidates,
	type SearchOptions,
	type SearchProvider,
	UpstreamError,
} from "./types";

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
		"google-cse": Boolean(
			config.GOOGLE_CSE_API_KEY && config.GOOGLE_CSE_ENGINE_ID,
		),
	};

	return config.SEARCH_PROVIDER_ORDER.filter(
		(name) => configured[name] && available.has(name),
	).map((name) => (available.get(name) as () => SearchProvider)());
}

export const upstream = createRotation(build());
