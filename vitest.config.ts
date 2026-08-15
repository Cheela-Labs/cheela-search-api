import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		globals: true,

		// `shared/config.ts` parses process.env once at import and freezes the
		// result, so these must be set here rather than with vi.stubEnv — by the
		// time a test body runs, `config` is already built.
		env: {
			// Required, so the module cannot be imported without one. This value
			// is never connected to; the migration suite reads TEST_DATABASE_URL
			// and skips when it is unset. Keeping them separate means a test run
			// cannot accidentally migrate a database somebody meant to keep.
			DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/none",

			// One provider, so the config refinement is satisfied. Provider tests
			// build their own instances against fixture servers and never read this.
			TAVILY_API_KEY: "tvly-test-not-a-real-key",

			// No free specialists in the suite, and this line is load-bearing.
			//
			// Wikipedia needs no credential, so unlike every paid vendor it is built
			// whenever it is listed — which means the process-wide `upstream` would
			// reach the real en.wikipedia.org from any test that uses the default
			// dependencies. A suite that quietly makes outbound calls is slow, fails
			// on a plane, and reports somebody else's incident as our regression.
			//
			// Specialist behaviour is covered in `test/upstream/providers.test.ts`
			// against fixture servers, which is where a provider's parsing belongs.
			SEARCH_SUPPLEMENTS: "",
		},

		include: ["test/**/*.test.ts"],
		exclude: ["dist/**", "coverage/**", "node_modules/**"],
	},
});
