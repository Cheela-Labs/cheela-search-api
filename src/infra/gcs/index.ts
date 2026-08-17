import { Storage } from "@google-cloud/storage";
import { config } from "../../shared/config.js";
import { logger } from "../../shared/logger.js";

/**
 * The raw-HTML archive.
 *
 * Every page the indexer fetches is written here before extraction is judged,
 * and the reason is that extraction is the part of this system most likely to
 * be wrong and most likely to improve. Roughly a third of the open web extracts
 * badly — storefronts render their catalogue in JavaScript, news sites bury
 * text in three wrappers — and a better extractor next month should get to
 * re-read those pages without asking the origin for them a second time.
 *
 * Without this, improving extraction means re-crawling, which costs bandwidth we
 * do not have, patience from hosts that have no reason to give it, and freshness
 * on pages that have since changed. The archive turns "re-extract the corpus"
 * from a crawl into a batch job.
 *
 * A 90-day lifecycle rule on the bucket bounds what that is worth paying for.
 */

export type Archive = {
	/** Returns the object path, or throws. Callers treat failure as non-fatal. */
	put(key: string, body: Buffer, contentType: string): Promise<string>;
	get(key: string): Promise<Buffer | null>;
};

export function createArchive(bucketName: string): Archive {
	// Constructed lazily on first use rather than at import. Application Default
	// Credentials are absent on a development machine, and a client built at
	// import time makes every test that imports the indexer reach for them.
	let bucket: ReturnType<Storage["bucket"]> | null = null;
	const open = () => {
		if (!bucket) bucket = new Storage().bucket(bucketName);
		return bucket;
	};

	return {
		async put(key, body, contentType) {
			await open()
				.file(key)
				.save(body, {
					contentType,
					// Fetched HTML is immutable at this key: the key contains the
					// document id, which is derived from the canonical URL, and a
					// changed page produces a changed body under the same key only
					// when it has genuinely been re-crawled.
					resumable: false,
					metadata: { cacheControl: "private, max-age=0" },
				});
			return `gs://${bucketName}/${key}`;
		},

		async get(key) {
			try {
				const [body] = await open().file(key).download();
				return body;
			} catch {
				// A 404 here is ordinary: the lifecycle rule deletes objects at 90
				// days and documents outlive their archived HTML by design.
				return null;
			}
		},
	};
}

/**
 * The archive, or a no-op when there is nowhere to write.
 *
 * A development machine has no bucket and no credentials, and the indexer must
 * still work there — the archive is an optimisation for a future re-extraction,
 * not a step the current pipeline depends on. Returning a stub keeps the
 * decision in one place instead of at every call site.
 */
export const archive: Archive = config.GCS_RAW_BUCKET.startsWith(
	"cheela-search-raw-test",
)
	? {
			put: async (key) => `stub://${key}`,
			get: async () => null,
		}
	: createArchive(config.GCS_RAW_BUCKET);

export async function archiveOrSkip(
	key: string,
	body: Buffer,
	contentType: string,
): Promise<string | undefined> {
	try {
		return await archive.put(key, body, contentType);
	} catch (error) {
		// Never fatal. Losing the archived copy costs a future re-extraction, not
		// this document — it is already extracted and about to be indexed.
		logger.warn(
			{ key, error: (error as Error).message },
			"could not archive raw html",
		);
		return undefined;
	}
}
