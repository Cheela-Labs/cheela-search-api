import { createVespaClient } from "@cheela/search-core";
import { config } from "../../shared/config.js";

/**
 * The process-wide Vespa client.
 *
 * The client itself lives in `@cheela/search-core` because the Console feeds the
 * same index this queries. What stays here is the *instance* — built from this
 * app's configuration, which the package deliberately does not read.
 */
export const vespa = createVespaClient(
	config.VESPA_ENDPOINT,
	config.VESPA_TIMEOUT_MS,
);
