import { defineConfig } from "tsup";

export default defineConfig({
	/*
	  Two entrypoints. The workers left with ingestion: crawling, indexing and
	  manifest sync belong to apps/search-console now (ADR-003), and this service
	  only serves queries.
	*/
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
