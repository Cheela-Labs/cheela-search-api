import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createEgressClient } from "../../src/infra/egress/client";
import { EgressError } from "../../src/infra/egress/errors";

/**
 * The acceptance criterion for step 1 of PLAN.md: this file has to prove
 * refusal of each of the metadata endpoint, private ranges, loopback,
 * link-local, a cross-host redirect chain, an oversized body, a slow-loris
 * body, and a hostname that resolves differently on the second lookup.
 *
 * Two client shapes, because they test different controls:
 *
 * - **`addressPolicyClient`** keeps the real address classifier and stubs the
 *   resolver. It never opens a socket — the point is that the refusal happens
 *   before one is opened.
 * - **`transportClient`** points at a fixture server on loopback, which the
 *   real classifier would (correctly) refuse. It injects a permissive
 *   classifier so that redirects, size caps and deadlines can be exercised
 *   against a real socket. That injection is why `classify` is a dependency
 *   rather than a config flag: there is no way to set it in production.
 *
 * Hostnames here are `.invalid` (RFC 2606, guaranteed never to resolve). If the
 * pinning mechanism ever stopped driving the connection and undici resolved the
 * name itself, every transport test would fail with ENOTFOUND rather than
 * passing against the wrong address — which is the failure mode worth having.
 */

const BASE = {
	timeoutMs: 2_000,
	maxBytes: 64 * 1024,
	maxRedirects: 3,
	userAgent: "CheelaSearchBot/0.1 (+test)",
};

const permissive = () => ({ allowed: true }) as const;

let servers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.map(
			(server) => new Promise<void>((resolve) => server.close(() => resolve())),
		),
	);
	servers = [];
});

async function serve(
	handler: Parameters<typeof createServer>[1],
): Promise<number> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return (server.address() as AddressInfo).port;
}

/** Refuses before any socket is opened; the resolver decides what the name is. */
function addressPolicyClient(address: string) {
	let calls = 0;
	const client = createEgressClient(BASE, {
		resolve: async () => {
			calls += 1;
			return [address];
		},
	});
	return { client, calls: () => calls };
}

function transportClient(overrides: Partial<typeof BASE> = {}) {
	let calls = 0;
	const client = createEgressClient(
		{ ...BASE, ...overrides },
		{
			resolve: async () => {
				calls += 1;
				return ["127.0.0.1"];
			},
			classify: permissive,
			// Fixture servers take an ephemeral port; the 80/443 rule is proven
			// against production defaults in the schemes-and-ports block below.
			allowPort: () => true,
		},
	);
	return { client, calls: () => calls };
}

async function refusal(promise: Promise<unknown>): Promise<EgressError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(EgressError);
		return error as EgressError;
	}
	throw new Error("expected the fetch to be refused, but it resolved");
}

describe("egress · addresses it must refuse", () => {
	it.each([
		["the cloud metadata endpoint", "169.254.169.254"],
		["link-local", "169.254.10.1"],
		["loopback", "127.0.0.1"],
		["private 10/8", "10.1.2.3"],
		["private 172.16/12", "172.20.0.5"],
		["private 192.168/16", "192.168.0.10"],
		["IPv6 loopback", "::1"],
		["IPv6 unique-local", "fd00::1"],
		["IPv4-mapped loopback", "::ffff:127.0.0.1"],
		["IPv4-mapped metadata", "::ffff:169.254.169.254"],
	])("refuses a hostname resolving to %s", async (_label, address) => {
		const { client } = addressPolicyClient(address);
		const error = await refusal(client.fetch("http://target.invalid/"));
		expect(error.reason).toBe("blocked-address");
	});

	it("refuses a literal IP in the URL without resolving anything", async () => {
		const { client, calls } = addressPolicyClient("1.1.1.1");
		const error = await refusal(client.fetch("http://169.254.169.254/"));
		expect(error.reason).toBe("blocked-address");
		// The literal is already the address that would be connected to, so a
		// resolver answer could only disagree with it.
		expect(calls()).toBe(0);
	});

	it("refuses a bracketed IPv6 literal", async () => {
		const { client } = addressPolicyClient("1.1.1.1");
		const error = await refusal(client.fetch("http://[::1]/"));
		expect(error.reason).toBe("blocked-address");
	});

	it("refuses the whole hostname when any one answer is blocked", async () => {
		// A name resolving to both a public address and loopback is not a name
		// with a good half — picking the survivor would make the outcome depend
		// on resolver ordering.
		const client = createEgressClient(BASE, {
			resolve: async () => ["93.184.216.34", "127.0.0.1"],
		});
		const error = await refusal(client.fetch("http://mixed.invalid/"));
		expect(error.reason).toBe("blocked-address");
	});
});

describe("egress · schemes and ports", () => {
	it.each(["file:///etc/passwd", "gopher://x.invalid/", "ftp://x.invalid/"])(
		"refuses %s",
		async (url) => {
			const { client } = addressPolicyClient("1.1.1.1");
			const error = await refusal(client.fetch(url));
			expect(error.reason).toBe("scheme-not-allowed");
		},
	);

	it("refuses a non-web port on an otherwise public host", async () => {
		const { client } = addressPolicyClient("1.1.1.1");
		const error = await refusal(client.fetch("http://public.invalid:6379/"));
		expect(error.reason).toBe("port-not-allowed");
	});

	it("refuses input that is not a URL at all", async () => {
		const { client } = addressPolicyClient("1.1.1.1");
		const error = await refusal(client.fetch("not a url"));
		expect(error.reason).toBe("invalid-url");
	});
});

describe("egress · DNS rebinding", () => {
	it("resolves once and connects to the address it checked", async () => {
		const port = await serve((_request, response) => {
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("pinned");
		});

		// Answers with the fixture server the first time and loopback-as-attacker
		// afterwards. If anything re-resolved, the second answer would be the one
		// used — so a single call is the property being asserted.
		let calls = 0;
		const client = createEgressClient(BASE, {
			resolve: async () => {
				calls += 1;
				return calls === 1 ? ["127.0.0.1"] : ["169.254.169.254"];
			},
			classify: permissive,
			allowPort: () => true,
		});

		const response = await client.fetch(`http://pinned.invalid:${port}/`);

		expect(response.body.toString()).toBe("pinned");
		expect(calls).toBe(1);
	});

	it("does not re-resolve across a same-host redirect", async () => {
		const port = await serve((request, response) => {
			if (request.url === "/one") {
				response.writeHead(302, { location: "/two" });
				response.end();
				return;
			}
			response.writeHead(200);
			response.end("arrived");
		});

		const { client, calls } = transportClient();
		const response = await client.fetch(`http://hop.invalid:${port}/one`);

		expect(response.body.toString()).toBe("arrived");
		expect(response.url).toContain("/two");
		// One lookup for the whole request, redirects included. A second would be
		// a second chance for DNS to answer differently.
		expect(calls()).toBe(1);
	});
});

describe("egress · redirects", () => {
	it("refuses a cross-host redirect", async () => {
		const port = await serve((_request, response) => {
			response.writeHead(302, { location: "http://elsewhere.invalid/" });
			response.end();
		});

		const { client } = transportClient();
		const error = await refusal(client.fetch(`http://start.invalid:${port}/`));
		expect(error.reason).toBe("cross-host-redirect");
	});

	it("refuses a redirect to a private address on another host", async () => {
		// The shape that matters: a public URL whose redirect target is the
		// metadata endpoint. Refused as cross-host before the address rules are
		// even consulted, which is why both controls exist.
		const port = await serve((_request, response) => {
			response.writeHead(302, { location: "http://169.254.169.254/token" });
			response.end();
		});

		const { client } = transportClient();
		const error = await refusal(client.fetch(`http://start.invalid:${port}/`));
		expect(error.reason).toBe("cross-host-redirect");
	});

	it("refuses a same-host redirect loop once the budget is spent", async () => {
		const port = await serve((_request, response) => {
			response.writeHead(302, { location: "/round" });
			response.end();
		});

		const { client } = transportClient({ maxRedirects: 2 });
		const error = await refusal(client.fetch(`http://loop.invalid:${port}/`));
		expect(error.reason).toBe("too-many-redirects");
	});

	it("follows a same-host redirect and reports the final URL", async () => {
		const port = await serve((request, response) => {
			if (request.url === "/a") {
				response.writeHead(301, { location: "/b" });
				response.end();
				return;
			}
			response.writeHead(200);
			response.end("final");
		});

		const { client } = transportClient();
		const response = await client.fetch(`http://ok.invalid:${port}/a`);
		expect(response.status).toBe(200);
		expect(response.url).toBe(`http://ok.invalid:${port}/b`);
	});
});

describe("egress · response limits", () => {
	it("refuses an oversized body declared in content-length", async () => {
		const payload = Buffer.alloc(200_000, "x");
		const port = await serve((_request, response) => {
			response.writeHead(200, { "content-length": String(payload.length) });
			response.end(payload);
		});

		const { client } = transportClient({ maxBytes: 1_000 });
		const error = await refusal(client.fetch(`http://big.invalid:${port}/`));
		expect(error.reason).toBe("response-too-large");
		expect(error.message).toContain("content-length");
	});

	it("refuses an oversized body that declares no length", async () => {
		// Chunked, so the header check cannot help and only the streaming cap
		// can. A server that lies about its length lands here too.
		const port = await serve((_request, response) => {
			response.writeHead(200, { "transfer-encoding": "chunked" });
			for (let i = 0; i < 50; i += 1) response.write(Buffer.alloc(4_096, "y"));
			response.end();
		});

		const { client } = transportClient({ maxBytes: 8_192 });
		const error = await refusal(client.fetch(`http://chunky.invalid:${port}/`));
		expect(error.reason).toBe("response-too-large");
	});

	it("accepts a body at the cap", async () => {
		const port = await serve((_request, response) => {
			response.writeHead(200);
			response.end(Buffer.alloc(1_000, "z"));
		});

		const { client } = transportClient({ maxBytes: 1_000 });
		const response = await client.fetch(`http://exact.invalid:${port}/`);
		expect(response.body.length).toBe(1_000);
	});
});

describe("egress · deadlines", () => {
	it("refuses a slow-loris body", async () => {
		// One byte every 50 ms and never an end. Every per-socket idle timeout is
		// satisfied by this; only a wall-clock deadline is not.
		const port = await serve((_request, response) => {
			response.writeHead(200, { "transfer-encoding": "chunked" });
			const tick = setInterval(() => response.write("."), 50);
			response.on("close", () => clearInterval(tick));
		});

		const { client } = transportClient({ timeoutMs: 400 });
		const started = Date.now();
		const error = await refusal(client.fetch(`http://slow.invalid:${port}/`));

		expect(error.reason).toBe("timeout");
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it("refuses a server that accepts and never answers", async () => {
		const port = await serve(() => {
			// Headers never sent.
		});

		const { client } = transportClient({ timeoutMs: 300 });
		const error = await refusal(client.fetch(`http://mute.invalid:${port}/`));
		expect(error.reason).toBe("timeout");
	});

	it("spends one deadline across a redirect chain, not one per hop", async () => {
		const port = await serve((request, response) => {
			if (request.url !== "/end") {
				setTimeout(() => {
					response.writeHead(302, { location: "/end" });
					response.end();
				}, 250);
				return;
			}
			setTimeout(() => {
				response.writeHead(200);
				response.end("late");
			}, 250);
		});

		// Each hop is comfortably inside 400ms; together they are not.
		const { client } = transportClient({ timeoutMs: 400 });
		const error = await refusal(
			client.fetch(`http://budget.invalid:${port}/a`),
		);
		expect(error.reason).toBe("timeout");
	});
});

describe("egress · the ordinary case", () => {
	it("returns status, headers and body", async () => {
		const port = await serve((request, response) => {
			response.writeHead(200, {
				"content-type": "text/html",
				"x-seen": request.headers["user-agent"] ?? "",
			});
			response.end("<h1>hello</h1>");
		});

		const { client } = transportClient();
		const response = await client.fetch(`http://fine.invalid:${port}/page`);

		expect(response.status).toBe(200);
		expect(response.headers["content-type"]).toBe("text/html");
		expect(response.body.toString()).toBe("<h1>hello</h1>");
		// Identified, so an operator can block us by name.
		expect(response.headers["x-seen"]).toContain("CheelaSearchBot");
	});

	it("returns a 404 rather than throwing — an error status is not a refusal", async () => {
		const port = await serve((_request, response) => {
			response.writeHead(404);
			response.end("nope");
		});

		const { client } = transportClient();
		const response = await client.fetch(`http://missing.invalid:${port}/`);
		expect(response.status).toBe(404);
	});
});
