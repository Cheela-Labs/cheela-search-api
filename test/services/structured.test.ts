import { describe, expect, it } from "vitest";
import {
	readStructured,
	safeUrl,
} from "../../src/services/structured/index.js";

/**
 * `readStructured` returns `[]` for no markup, for malformed JSON, and for
 * markup of types nothing reads. All three are correct, and all three are
 * indistinguishable from the function being broken — which is the entire
 * reason this file exists. Every module downstream renders nothing when this
 * returns nothing, so a silent regression here would look exactly like the web
 * simply not publishing structured data.
 */

const block = (value: unknown) => JSON.stringify(value);

describe("safeUrl", () => {
	it("keeps http and https", () => {
		expect(safeUrl("https://redis.io/")).toBe("https://redis.io/");
		expect(safeUrl("http://example.com/a")).toBe("http://example.com/a");
	});

	it("rejects every scheme that could reach an href", () => {
		expect(safeUrl("javascript:alert(1)")).toBeNull();
		expect(safeUrl("data:text/html,<script>")).toBeNull();
		expect(safeUrl("file:///etc/passwd")).toBeNull();
		expect(safeUrl("  javascript:alert(1)  ")).toBeNull();
	});

	it("rejects what is not a url at all", () => {
		expect(safeUrl("redis.io")).toBeNull();
		expect(safeUrl("")).toBeNull();
		expect(safeUrl(undefined)).toBeNull();
		expect(safeUrl(42)).toBeNull();
	});
});

describe("readStructured — abstaining", () => {
	it("returns nothing for absent markup", () => {
		expect(readStructured("")).toEqual([]);
		expect(readStructured(undefined)).toEqual([]);
		expect(readStructured(null)).toEqual([]);
	});

	it("returns nothing for malformed json rather than throwing", () => {
		expect(readStructured("{ not json")).toEqual([]);
		expect(readStructured("[{'single': 'quotes'}]")).toEqual([]);
	});

	it("drops types no module reads", () => {
		expect(
			readStructured(
				block([
					{ "@type": "WebPage", name: "A page" },
					{ "@type": "SiteNavigationElement", name: "Home" },
				]),
			),
		).toEqual([]);
	});

	it("drops a recognised type carrying nothing", () => {
		// An empty list is not a breadcrumb trail.
		expect(
			readStructured(
				block([{ "@type": "BreadcrumbList", itemListElement: [] }]),
			),
		).toEqual([]);
	});

	it("drops a node whose every property was filtered out", () => {
		// A recognised type carrying nothing worth carrying is not a node.
		expect(
			readStructured(
				block([{ "@type": "Product", isbn: "123", gtin13: "456" }]),
			),
		).toEqual([]);
	});
});

describe("readStructured — shapes", () => {
	it("flattens @graph", () => {
		const nodes = readStructured(
			block({
				"@context": "https://schema.org",
				"@graph": [
					{ "@type": "Organization", name: "Redis" },
					{ "@type": "WebPage", name: "ignored" },
					{
						"@type": "BreadcrumbList",
						itemListElement: [
							{ "@type": "ListItem", position: 1, name: "Docs" },
							{ "@type": "ListItem", position: 2, name: "Commands" },
						],
					},
				],
			}),
		);
		expect(nodes.map((node) => node.type)).toEqual([
			"Organization",
			"BreadcrumbList",
		]);
	});

	it("reads an Event with its venue and its offer", () => {
		const [event] = readStructured(
			block([
				{
					"@type": "Event",
					name: "RedisConf 2026",
					startDate: "2026-10-14T09:00:00-07:00",
					endDate: "2026-10-16T18:00:00-07:00",
					eventAttendanceMode: "https://schema.org/MixedEventAttendanceMode",
					location: {
						"@type": "PostalAddress",
						name: "Moscone West",
						addressLocality: "San Francisco",
					},
					offers: {
						"@type": "Offer",
						price: "349",
						priceCurrency: "USD",
						availability: "https://schema.org/InStock",
					},
				},
			]),
		);
		expect(event.type).toBe("Event");
		expect(event.props.name).toBe("RedisConf 2026");
		expect(event.props.startDate).toBe("2026-10-14T09:00:00-07:00");

		const location = event.props.location as {
			type: string;
			props: Record<string, unknown>;
		}[];
		expect(location[0].props.addressLocality).toBe("San Francisco");

		const offers = event.props.offers as {
			type: string;
			props: Record<string, unknown>;
		}[];
		expect(offers[0].type).toBe("Offer");
		expect(offers[0].props.price).toBe("349");
	});

	it("reads a numeric price as a string, because a price is not arithmetic", () => {
		const [product] = readStructured(
			block([
				{
					"@type": "Product",
					name: "Q2 Pro",
					offers: { "@type": "Offer", price: 179 },
				},
			]),
		);
		const offers = product.props.offers as { props: Record<string, unknown> }[];
		expect(offers[0].props.price).toBe("179");
	});

	it("normalises an unrecognised business subtype by its shape", () => {
		const [venue] = readStructured(
			block([
				{
					"@type": "CafeOrCoffeeShop",
					name: "Allpress Espresso",
					address: { "@type": "PostalAddress", streetAddress: "Redchurch St" },
					telephone: "+44 20 7749 1780",
				},
			]),
		);
		expect(venue.type).toBe("LocalBusiness");
		expect(venue.props.name).toBe("Allpress Espresso");
	});

	it("does not invent a business out of an address alone", () => {
		// No telephone, no hours, no geo — this is a postal address on a contact
		// page, not a place the reader can be sent to.
		expect(
			readStructured(
				block([
					{ "@type": "ContactPage", address: { streetAddress: "1 Any St" } },
				]),
			),
		).toEqual([]);
	});

	it("takes the first recognised member of an @type array", () => {
		const [node] = readStructured(
			block([{ "@type": ["Thing", "SoftwareApplication"], name: "Redis" }]),
		);
		expect(node.type).toBe("SoftwareApplication");
	});

	it("strips the schema.org prefix off a @type", () => {
		const [node] = readStructured(
			block([{ "@type": "https://schema.org/VideoObject", name: "A talk" }]),
		);
		expect(node.type).toBe("VideoObject");
	});

	it("reads a VideoObject and its chapters", () => {
		const [video] = readStructured(
			block([
				{
					"@type": "VideoObject",
					name: "Redis in 100 minutes",
					duration: "PT1H42M8S",
					thumbnailUrl: "https://i.example.com/still.jpg",
					hasPart: [
						{ "@type": "Clip", name: "Data types", startOffset: 252 },
						{ "@type": "Clip", name: "Persistence", startOffset: 1300 },
					],
				},
			]),
		);
		expect(video.props.duration).toBe("PT1H42M8S");
		expect(video.props.thumbnailUrl).toBe("https://i.example.com/still.jpg");
		const parts = video.props.hasPart as { props: Record<string, unknown> }[];
		expect(parts).toHaveLength(2);
		expect(parts[1].props.startOffset).toBe("1300");
	});
});

describe("readStructured — hostile and oversized input", () => {
	it("drops a javascript: url wherever it appears", () => {
		const [node] = readStructured(
			block([
				{
					"@type": "Organization",
					name: "Evil",
					url: "javascript:alert(1)",
					sameAs: ["javascript:alert(2)", "https://example.com/real"],
				},
			]),
		);
		expect(node.props.url).toBeUndefined();
		expect(node.props.sameAs).toBe("https://example.com/real");
	});

	it("stops at the node cap", () => {
		const many = Array.from({ length: 20 }, (_, index) => ({
			"@type": "Organization",
			name: `Org ${index}`,
		}));
		expect(readStructured(block(many))).toHaveLength(3);
	});

	it("stops at the byte cap before the node cap when nodes are large", () => {
		const fat = Array.from({ length: 3 }, (_, index) => ({
			"@type": "Article",
			headline: `Article ${index}`,
			description: "x".repeat(600),
			abstract: "y".repeat(600),
			about: "z".repeat(600),
			text: "w".repeat(600),
		}));
		expect(readStructured(block(fat)).length).toBeLessThan(3);
	});

	it("truncates a single overlong string rather than carrying an article", () => {
		const [node] = readStructured(
			block([
				{ "@type": "Article", headline: "H", description: "x".repeat(5000) },
			]),
		);
		expect((node.props.description as string).length).toBe(600);
	});

	it("truncates an overlong array", () => {
		const [node] = readStructured(
			block([
				{
					"@type": "VideoObject",
					name: "Long",
					hasPart: Array.from({ length: 400 }, (_, index) => ({
						"@type": "Clip",
						name: `Chapter ${index}`,
					})),
				},
			]),
		);
		expect((node.props.hasPart as unknown[]).length).toBe(12);
	});

	it("does not recurse without bound", () => {
		// Three levels deep; the third keeps only its name.
		const [node] = readStructured(
			block([
				{
					"@type": "Product",
					name: "Outer",
					offers: {
						"@type": "Offer",
						price: "1",
						seller: {
							"@type": "Organization",
							name: "Middle",
							logo: "https://e.com/l.png",
						},
					},
				},
			]),
		);
		const offers = node.props.offers as { props: Record<string, unknown> }[];
		expect(offers[0].props.seller).toBe("Middle");
	});

	it("survives a self-referential structure", () => {
		// JSON cannot express a cycle, but `@id` references are how publishers
		// approximate one, and they must not be followed.
		const nodes = readStructured(
			block([
				{
					"@type": "Organization",
					"@id": "#org",
					name: "Redis",
					publisher: { "@id": "#org" },
				},
			]),
		);
		expect(nodes[0].props.name).toBe("Redis");
	});
});
