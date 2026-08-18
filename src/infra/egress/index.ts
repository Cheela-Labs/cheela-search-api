import { createEgressClient, createRobotsPolicy } from "@cheela/search-core";
import { config } from "../../shared/config.js";

/**
 * The process-wide egress client.
 *
 * The policy itself — the address deny-ranges, the DNS pinning, the redirect
 * and byte caps, the robots parser — lives in `@cheela/search-core`, because
 * the Console fetches attacker-influenceable URLs too and two copies of that
 * table can drift where TypeScript cannot see it.
 *
 * What stays here is the *instance*: this app's settings, and the wiring of the
 * robots policy to a client that does not itself check robots, since otherwise
 * the first fetch of any origin recurses forever.
 */
const settings = {
	timeoutMs: config.EGRESS_TIMEOUT_MS,
	maxBytes: config.EGRESS_MAX_BYTES,
	maxRedirects: config.EGRESS_MAX_REDIRECTS,
	userAgent: config.EGRESS_USER_AGENT,
	respectRobots: config.EGRESS_RESPECT_ROBOTS,
};

const bare = createEgressClient(settings);

export const egress = createEgressClient(settings, {
	robots: createRobotsPolicy(async (url: string) => {
		const response = await bare.fetchRaw(url);
		return { status: response.status, body: response.body };
	}),
});
