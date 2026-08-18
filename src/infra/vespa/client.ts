import { createVespaClient } from "@cheela/search-core";
import { config } from "../../shared/config.js";

/**
 * The process-wide Vespa client.
 *
 * The client itself lives in `@cheela/search-core` because the Console feeds the
 * same index this queries. What stays here is the *instance* — built from this
 * app's configuration, which the package deliberately does not read.
 */
/**
 * The client waits longer than Vespa does, deliberately.
 *
 * `VESPA_TIMEOUT_MS` is what the query carries in its own `timeout` field, and
 * with `ranking.softtimeout` enabled that is an instruction to Vespa to *return
 * what it has* at the deadline rather than fail. The client's budget covers
 * that plus the round trip. Set them equal — as this once did — and the abort
 * always wins the race, because the response still has to travel back; the
 * partial result Vespa dutifully produced is discarded in flight and the query
 * is recorded as a Vespa failure.
 */
export const vespa = createVespaClient(
	config.VESPA_ENDPOINT,
	config.VESPA_TIMEOUT_MS + config.VESPA_TRANSPORT_MARGIN_MS,
);
