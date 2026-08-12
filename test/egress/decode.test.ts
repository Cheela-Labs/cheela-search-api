import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	brotliCompressSync,
	deflateRawSync,
	deflateSync,
	gzipSync,
} from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createEgressClient } from "../../src/infra/egress/client";
import { EgressError } from "../../src/infra/egress/errors";

/**
 * Response decoding.
 *
 * These exist because the absence of them cost most of a corpus. undici's
 * `request()` does not decompress — `fetch()` does — so the client advertised
 * `accept-encoding` and then handed the extractor gzip. Nothing threw: the
 * extractor found no article in the binary and reported `no-main-content`, which
 * reads as an ordinary extraction failure on an ordinary page. Measured against
 * the live web it scored 1 page in 8; against fixtures that were never
 * compressed, 8 in 8.
 */

const CONFIG = {
	timeoutMs: 2_000,
	maxBytes: 1_000_000,
	maxRedirects: 1,
	userAgent: "CheelaSearchBot/0.1 (+test)",
};

let servers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.map((s) => new Promise<void>((r) => s.close(() => r()))),
	);
	servers = [];
});

async function serve(encoding: string, body: Buffer): Promise<number> {
	const server = createServer((_request, response) => {
		response.writeHead(200, {
			"content-type": "text/html",
			...(encoding ? { "content-encoding": encoding } : {}),
		});
		response.end(body);
	});
	servers.push(server);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	return (server.address() as AddressInfo).port;
}

const client = (overrides: Partial<typeof CONFIG> = {}) =>
	createEgressClient(
		{ ...CONFIG, ...overrides },
		{
			resolve: async () => ["127.0.0.1"],
			classify: () => ({ allowed: true }) as const,
			allowPort: () => true,
		},
	);

const HTML =
	"<html><body><article><p>readable text</p></article></body></html>";

describe("egress · response decoding", () => {
	it.each([
		["gzip", gzipSync(Buffer.from(HTML))],
		["x-gzip", gzipSync(Buffer.from(HTML))],
		["br", brotliCompressSync(Buffer.from(HTML))],
		["deflate", deflateSync(Buffer.from(HTML))],
	])("decodes %s", async (encoding, body) => {
		const port = await serve(encoding, body);
		const response = await client().fetch(`http://a.invalid:${port}/`);
		expect(response.body.toString("utf8")).toBe(HTML);
	});

	it("decodes raw deflate, which servers also mean by `deflate`", async () => {
		// Both spellings are common enough that guessing one loses pages.
		const port = await serve("deflate", deflateRawSync(Buffer.from(HTML)));
		const response = await client().fetch(`http://a.invalid:${port}/`);
		expect(response.body.toString("utf8")).toBe(HTML);
	});

	it("passes an uncompressed body through untouched", async () => {
		const port = await serve("", Buffer.from(HTML));
		const response = await client().fetch(`http://a.invalid:${port}/`);
		expect(response.body.toString("utf8")).toBe(HTML);
	});

	it("stops claiming an encoding once the body no longer has one", async () => {
		const port = await serve("gzip", gzipSync(Buffer.from(HTML)));
		const response = await client().fetch(`http://a.invalid:${port}/`);
		// A caller that trusted the header would decompress twice.
		expect(response.headers["content-encoding"]).toBeUndefined();
	});

	it("refuses a body that expands past the cap", async () => {
		// A kilobyte of gzip becomes a gigabyte if nothing bounds the output. The
		// wire-size cap upstream cannot see this coming.
		const bomb = gzipSync(Buffer.alloc(5_000_000, "a"));
		expect(bomb.length).toBeLessThan(50_000);

		const port = await serve("gzip", bomb);
		const error = await client({ maxBytes: 100_000 })
			.fetch(`http://a.invalid:${port}/`)
			.then(() => null)
			.catch((e: unknown) => e as EgressError);

		expect(error).toBeInstanceOf(EgressError);
		expect(error?.reason).toBe("response-too-large");
	});

	it("names a corrupt body as a decode failure, not an extraction one", async () => {
		const port = await serve("gzip", Buffer.from("this is not gzip"));
		const error = await client()
			.fetch(`http://a.invalid:${port}/`)
			.then(() => null)
			.catch((e: unknown) => e as EgressError);

		expect(error?.reason).toBe("decode-failed");
	});

	it("passes through an encoding it does not implement", async () => {
		// Left for extraction to refuse as `not-html`, rather than throwing on
		// something that may be harmless.
		const port = await serve("exotic-v9", Buffer.from(HTML));
		const response = await client().fetch(`http://a.invalid:${port}/`);
		expect(response.body.toString("utf8")).toBe(HTML);
	});

	it("asks for the encodings it can actually decode", async () => {
		const seen: { accept?: string } = {};
		const server = createServer((request, response) => {
			seen.accept = request.headers["accept-encoding"] as string;
			response.writeHead(200, { "content-type": "text/html" });
			response.end(HTML);
		});
		servers.push(server);
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as AddressInfo).port;

		await client().fetch(`http://a.invalid:${port}/`);
		// Advertising an encoding this client cannot decode is what caused the
		// bug these tests exist for.
		expect(seen.accept).toContain("gzip");
		expect(seen.accept).toContain("br");
		expect(seen.accept).toContain("deflate");
	});
});
