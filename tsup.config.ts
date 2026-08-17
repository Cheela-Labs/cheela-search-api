import { defineConfig } from "tsup";

export default defineConfig({
	/*
	  Four entrypoints, one image.

	  `index.ts` serves HTTP. `worker.ts` consumes the event streams and is a
	  separate Cloud Run *service* with min-instances=1, because a Redis Streams
	  consumer on a scale-to-zero service is a consumer that is usually not
	  running. `scheduler.ts` is a Cloud Run Job on Cloud Scheduler. `migrate.ts`
	  is a Job that must finish before a revision serves.

	  They share an image so the deployed code is provably the same code; they are
	  separate processes so a stuck crawl cannot occupy a request thread.
	*/
	entry: [
		"src/index.ts",
		"src/worker.ts",
		"src/scheduler.ts",
		"src/migrate.ts",
	],
	format: ["esm"],
	splitting: false,
	sourcemap: true,
	clean: true,
	dts: false,
	target: "node22",
	platform: "node",
	outDir: "dist",
});
