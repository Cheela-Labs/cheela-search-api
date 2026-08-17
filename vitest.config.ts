import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		globals: true,

		/*
		  `shared/config.ts` parses process.env once at import and freezes the
		  result, so these must be set here rather than with vi.stubEnv — by the
		  time a test body runs, `config` is already built.

		  Every value here is deliberately unusable. The rule is that a test run
		  must not be able to reach a real dependency by accident: a suite that
		  quietly makes outbound calls is slow, fails on a plane, and reports
		  somebody else's incident as our regression. Tests that need a real
		  dependency read TEST_DATABASE_URL / TEST_REDIS_URL / TEST_VESPA_ENDPOINT
		  and skip themselves when it is absent.
		*/
		env: {
			// Never connected to. Port 1 is unbindable, so a store that forgets to
			// check for a test double fails loudly instead of silently talking to
			// a database somebody meant to keep.
			DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/none",
			REDIS_URL: "redis://127.0.0.1:1",
			VESPA_ENDPOINT: "http://127.0.0.1:1",

			TAVILY_API_KEY: "tvly-test-not-a-real-key",
			ANYSEARCH_API_KEY: "as-test-not-a-real-key",
			MODEL_API_KEY: "sk-test-not-a-real-key",

			// Long enough to satisfy the schema's minimum. Signing tests build
			// their own signer with a known key rather than reading this.
			EVENT_SIGNING_KEY: "test-event-signing-key-not-a-real-secret",

			GCS_RAW_BUCKET: "cheela-search-raw-test",

			// The gate is exercised by giving the app a token explicitly; the
			// default must not be a value a request could guess.
			SEARCH_API_TOKEN: "test-search-api-token",
		},

		include: ["test/**/*.test.ts"],
		exclude: ["dist/**", "coverage/**", "node_modules/**"],
	},
});
