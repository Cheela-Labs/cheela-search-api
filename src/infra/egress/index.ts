import { config } from "../../shared/config.js";
import { createEgressClient } from "./client.js";
import { createRobotsPolicy } from "./robots.js";

export type { AddressVerdict } from "./addresses.js";
export { classifyAddress, parseIPv4 } from "./addresses.js";
export type {
	EgressClient,
	EgressConfig,
	EgressRequest,
	EgressResponse,
} from "./client.js";
export { createEgressClient } from "./client.js";
export type { EgressRefusal } from "./errors.js";
export { EgressError, isEgressError } from "./errors.js";
export type { RobotsPolicy } from "./robots.js";
export {
	createRobotsPolicy,
	isAllowed,
	parseRobots,
	productToken,
} from "./robots.js";

const settings = {
	timeoutMs: config.EGRESS_TIMEOUT_MS,
	maxBytes: config.EGRESS_MAX_BYTES,
	maxRedirects: config.EGRESS_MAX_REDIRECTS,
	userAgent: config.EGRESS_USER_AGENT,
	respectRobots: config.EGRESS_RESPECT_ROBOTS,
};

/**
 * robots.txt is fetched through a client that does not itself check robots —
 * otherwise the first fetch of any origin recurses forever. That client is
 * built from the same settings, so a robots fetch is still bounded, still
 * address-checked and still pinned.
 */
const bare = createEgressClient(settings);

/** The process-wide client. Everything outbound uses this. */
export const egress = createEgressClient(settings, {
	robots: createRobotsPolicy(async (url) => {
		const response = await bare.fetchRaw(url);
		return { status: response.status, body: response.body };
	}),
});
