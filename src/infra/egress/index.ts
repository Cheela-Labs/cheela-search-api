import { config } from "../../shared/config";
import { createEgressClient } from "./client";

export { type AddressVerdict, classifyAddress } from "./addresses";
export {
	createEgressClient,
	type EgressClient,
	type EgressConfig,
	type EgressResponse,
} from "./client";
export { EgressError, type EgressRefusal, isEgressError } from "./errors";

/**
 * The process-wide client. Import this, not `createEgressClient` — the factory
 * exists so tests can inject a resolver and an address policy, and a second
 * production instance would be a second policy waiting to drift from this one.
 */
export const egress = createEgressClient({
	timeoutMs: config.EGRESS_TIMEOUT_MS,
	maxBytes: config.EGRESS_MAX_BYTES,
	maxRedirects: config.EGRESS_MAX_REDIRECTS,
	userAgent: config.EGRESS_USER_AGENT,
});
