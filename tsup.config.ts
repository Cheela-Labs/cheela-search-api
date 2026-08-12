import { defineConfig } from "tsup";

export default defineConfig({
	// Two entrypoints: the server, and the migration runner that must be a
	// separate process from it. See src/migrate.ts.
	entry: ["src/index.ts", "src/migrate.ts"],
	format: ["esm"],
	splitting: false,
	sourcemap: true,
	clean: true,
	dts: false,
	target: "node22",
	platform: "node",
	outDir: "dist",
});
