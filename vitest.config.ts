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
		},

		include: ["test/**/*.test.ts"],
		exclude: ["dist/**", "coverage/**", "node_modules/**"],
	},
});
