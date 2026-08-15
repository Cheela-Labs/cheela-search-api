import { readFile } from "node:fs/promises";
import { classifier } from "../src/domain/route";
import { routeStructurally } from "../src/domain/route/structural";
import type { Intent } from "../src/shared/events";

/**
 * Routing, per query, against the real model.
 *
 * The eval harness reports routing accuracy as one number, and that number
 * cannot be acted on. This prints the verdict for every labelled query, which
 * is what turns "96%" into "`injection-passage` is being called navigational".
 *
 * It exists because it earned itself: adding the freshness rules to the
 * classifier prompt reliably flipped exactly one query, and the aggregate said
 * only that something had moved. **Prompt behaviour is not unit-testable** —
 * `test/route/route.test.ts` drives a stub model and asserts the parsing, which
 * is the right thing for it to do and says nothing about what a real model
 * returns. This is the guard for the other half.
 *
 * Cheap: one small-model call per query, no retrieval, no page fetches.
 *
 * Run: `pnpm --filter @cheela/search-api exec tsx scripts/route-check.ts`
 */

type Label = { id?: string; query: string; intent?: Intent };

async function main(): Promise<void> {
	const path = new URL("../eval/queries.jsonl", import.meta.url).pathname;
	const text = await readFile(path, "utf8");

	let checked = 0;
	let right = 0;
	const misses: string[] = [];

	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("//")) continue;

		const label = JSON.parse(line) as Label;
		if (!label.intent) continue;

		const id = label.id ?? label.query.slice(0, 24);

		// The structural pass first, exactly as the pipeline does it — otherwise
		// this would report the model's opinion of a URL the pipeline never asks
		// it about.
		const structural = routeStructurally(label.query);
		const route =
			structural.intent === "navigational"
				? { intent: "navigational" as Intent, freshness: "shortcut" }
				: await classifier(label.query);

		checked += 1;
		const ok = route.intent === label.intent;
		if (ok) right += 1;
		else misses.push(id);

		console.log(
			`  ${ok ? " " : "✗"} ${id.padEnd(20)} want=${String(label.intent).padEnd(14)}` +
				` got=${String(route.intent).padEnd(14)} freshness=${route.freshness}`,
		);
	}

	console.log(
		`\n  ${right}/${checked} routed correctly` +
			(misses.length ? `  — missed: ${misses.join(", ")}` : ""),
	);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exit(1);
});
