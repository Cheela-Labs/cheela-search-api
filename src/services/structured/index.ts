import { logger } from "../../shared/logger.js";

/**
 * Publisher JSON-LD, turned into something a surface can render.
 *
 * The crawler already lifts every `<script type="application/ld+json">` block
 * off every page it fetches and stores the lot verbatim — `web_document.sd`
 * says why: *"schema.org is open-ended and the fields worth having tomorrow are
 * not knowable today; keeping the block means a later reader can ask a question
 * this schema never anticipated."* This module is that later reader.
 *
 * Three things happen here and none of them may happen in a browser.
 *
 * **Parsing.** This is a string a stranger put in their HTML. It is parsed
 * once, on a server, behind a try/catch, rather than shipping a parser for
 * hostile JSON to every client on every result.
 *
 * **Pruning.** A single retail page's block runs past 20KB — variant matrices,
 * every review, the full breadcrumb tree. Twenty of those on one response is a
 * quarter-megabyte of wire for a card that shows a price. Only whitelisted
 * types survive, and only within a byte cap.
 *
 * **URL validation.** Anything URL-shaped is checked to be `http(s)` here, so
 * that nothing downstream has to remember to. A publisher-supplied
 * `javascript:` value must never reach an `href`, and the one place to
 * guarantee that is the one place the value is first understood as a URL.
 *
 * What this module deliberately does *not* do is decide whether any of it is
 * true. `Product.price` is what a page says about itself. Every consumer
 * renders it attributed to the domain it came from and none of them aggregate
 * it into a number of ours.
 */

export type StructuredValue = string | string[] | StructuredNode[];

export type StructuredNode = {
	/** The normalised `@type`, always one of `TYPES` below. */
	type: string;
	props: Record<string, StructuredValue>;
};

/**
 * The types any module reads. Everything else is dropped.
 *
 * An allow-list rather than a deny-list because the cost of the two is
 * asymmetric: a type missing from here means a module quietly does not render,
 * which is visible the first time someone looks for it. A deny-list means
 * whatever schema.org adds next ships to every client by default.
 */
const TYPES = new Set([
	// Identity
	"Organization",
	"Person",
	"SoftwareApplication",
	// Commerce
	"Product",
	"Offer",
	"AggregateOffer",
	"AggregateRating",
	// Places and occasions
	"Event",
	"LocalBusiness",
	"PostalAddress",
	"OpeningHoursSpecification",
	"GeoCoordinates",
	// Media
	"VideoObject",
	"Clip",
	"Movie",
	"TVSeries",
	// Text
	"Article",
	"NewsArticle",
	"ScholarlyArticle",
	"TechArticle",
	"APIReference",
	"MedicalWebPage",
	"HowTo",
	"HowToStep",
	"Course",
	"CourseInstance",
	"BreadcrumbList",
	"ListItem",
	"SoftwareSourceCode",
]);

/**
 * Properties worth carrying, per type family.
 *
 * Kept as one flat set rather than a map of type to properties. schema.org
 * shares property names across types by design — `name`, `url`, `description`
 * and `image` are on nearly everything — and a per-type map would restate them
 * thirty times and then disagree with itself the first time one was forgotten.
 */
const PROPS = new Set([
	"name",
	"alternateName",
	"headline",
	"description",
	"abstract",
	"url",
	"sameAs",
	"image",
	"thumbnailUrl",
	"logo",
	// Commerce
	"price",
	"priceCurrency",
	"lowPrice",
	"highPrice",
	"offerCount",
	"availability",
	"itemCondition",
	"seller",
	"offers",
	"brand",
	"sku",
	"ratingValue",
	"bestRating",
	"reviewCount",
	"ratingCount",
	"aggregateRating",
	// Occasions
	"startDate",
	"endDate",
	"doorTime",
	"eventAttendanceMode",
	"eventStatus",
	"location",
	"performer",
	"organizer",
	// Places
	"address",
	"streetAddress",
	"addressLocality",
	"addressRegion",
	"postalCode",
	"addressCountry",
	"telephone",
	"openingHours",
	"openingHoursSpecification",
	"dayOfWeek",
	"opens",
	"closes",
	"geo",
	"latitude",
	"longitude",
	// Media
	"duration",
	"uploadDate",
	"embedUrl",
	"contentUrl",
	"startOffset",
	"endOffset",
	"hasPart",
	"partOfSeries",
	"numberOfEpisodes",
	"numberOfSeasons",
	"contentRating",
	"genre",
	// Text
	"datePublished",
	"dateModified",
	"lastReviewed",
	"reviewedBy",
	"author",
	"publisher",
	"citation",
	"about",
	"articleSection",
	"proficiencyLevel",
	"programmingLanguage",
	"codeSampleType",
	"text",
	"timeRequired",
	"educationalLevel",
	"teaches",
	"totalTime",
	"step",
	"itemListElement",
	"position",
	"item",
	"version",
	"softwareVersion",
	"applicationCategory",
	"operatingSystem",
	"datePosted",
]);

/** Properties whose values are URLs and must survive validation to be kept. */
const URL_PROPS = new Set([
	"url",
	"sameAs",
	"image",
	"thumbnailUrl",
	"logo",
	"embedUrl",
	"contentUrl",
]);

/**
 * The caps.
 *
 * Both exist because a silent overrun here is invisible from the outside — the
 * module renders slightly less and nobody can tell it was truncated rather than
 * sparse — so both are logged when they bite.
 */
const MAX_NODES = 3;
const MAX_BYTES = 4096;
/**
 * Levels of nesting read in full. One.
 *
 * An `Offer` inside a `Product`, a `PostalAddress` inside an `Event`, a `Clip`
 * inside a `VideoObject` — every case a module actually reads is one level
 * down. Anything deeper collapses to its `name`, which is all a third level is
 * ever worth: `Product.offers.seller` needs to say "keychron.com", not carry an
 * entire Organization node to do it.
 */
const MAX_DEPTH = 1;
/** Longest single string kept. A `description` can be an entire article. */
const MAX_STRING = 600;
/** Longest array kept. `hasPart` on a long video runs to hundreds of clips. */
const MAX_ARRAY = 12;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether a value is a URL we are willing to hand to an `href`.
 *
 * `http(s)` only. `javascript:`, `data:` and `file:` are the reason this
 * function exists rather than a regex on "starts with http".
 */
export function safeUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 2000) return null;
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
			return null;
		return parsed.toString();
	} catch {
		return null;
	}
}

/**
 * The `@type`, normalised.
 *
 * `@type` is legitimately an array — a node can be both a `Product` and a
 * `SoftwareApplication` — so the first recognised member wins. The fallback is
 * the one piece of interpretation in this file: `LocalBusiness` has dozens of
 * subtypes (`Restaurant`, `CafeOrCoffeeShop`, `Store`, `Dentist`…) and
 * enumerating them would be a list that is wrong the week schema.org adds
 * another. A node carrying a postal address and a way to visit or call it is
 * a local business whatever it calls itself.
 */
function normalizeType(
	raw: unknown,
	node: Record<string, unknown>,
): string | null {
	const candidates = (Array.isArray(raw) ? raw : [raw])
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.split("/").pop() ?? entry);

	for (const candidate of candidates) {
		if (TYPES.has(candidate)) return candidate;
	}

	if (candidates.length > 0 && "address" in node) {
		if (
			"telephone" in node ||
			"openingHours" in node ||
			"openingHoursSpecification" in node ||
			"geo" in node
		) {
			return "LocalBusiness";
		}
	}
	return null;
}

function readString(value: unknown): string | null {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? trimmed.slice(0, MAX_STRING) : null;
	}
	// schema.org permits `{ "@value": "…" }` wherever a literal is allowed.
	if (isRecord(value) && typeof value["@value"] === "string") {
		return readString(value["@value"]);
	}
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return null;
}

function readValue(
	key: string,
	value: unknown,
	depth: number,
): StructuredValue | null {
	if (Array.isArray(value)) {
		const nodes: StructuredNode[] = [];
		const strings: string[] = [];
		for (const entry of value.slice(0, MAX_ARRAY)) {
			const read = readValue(key, entry, depth);
			if (read === null) continue;
			if (Array.isArray(read)) {
				for (const item of read) {
					if (typeof item === "string") strings.push(item);
					else nodes.push(item);
				}
			} else if (typeof read === "string") {
				strings.push(read);
			}
		}
		if (nodes.length > 0) return nodes;
		return strings.length > 0 ? strings : null;
	}

	if (isRecord(value)) {
		// A bare `{ "@id": "…" }` is a reference to a node defined elsewhere.
		// Nothing here resolves references, so it is a URL or it is nothing.
		if (!("@type" in value) && typeof value["@id"] === "string") {
			const url = safeUrl(value["@id"]);
			return url ? [url] : null;
		}
		if (depth >= MAX_DEPTH) {
			// Out of depth: keep the name if it has one, so `seller` on an offer
			// is still "keychron.com" rather than nothing at all.
			const name = readString(value.name);
			return name ? [name] : null;
		}
		const node = readNode(value, depth + 1);
		return node ? [node] : null;
	}

	if (URL_PROPS.has(key)) {
		const url = safeUrl(value);
		return url ? [url] : null;
	}

	const text = readString(value);
	return text ? [text] : null;
}

function readNode(
	raw: Record<string, unknown>,
	depth: number,
): StructuredNode | null {
	const type = normalizeType(raw["@type"], raw);
	if (!type) return null;

	const props: Record<string, StructuredValue> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!PROPS.has(key)) continue;
		const read = readValue(key, value, depth);
		if (read === null) continue;
		// A single-element array of a string is the common case and reads badly
		// downstream; collapse it so `props.name` is a string.
		props[key] =
			Array.isArray(read) && read.length === 1 && typeof read[0] === "string"
				? read[0]
				: read;
	}

	return Object.keys(props).length > 0 ? { type, props } : null;
}

/** Flattens `@graph` wrappers and top-level arrays into a list of raw nodes. */
function flatten(value: unknown, into: Record<string, unknown>[]): void {
	if (Array.isArray(value)) {
		for (const entry of value) flatten(entry, into);
		return;
	}
	if (!isRecord(value)) return;
	if (Array.isArray(value["@graph"])) {
		flatten(value["@graph"], into);
		return;
	}
	into.push(value);
}

/**
 * Reads a document's stored JSON-LD into the nodes a surface can render.
 *
 * Returns `[]` for anything unexpected — no markup, malformed JSON, only types
 * nothing reads. That is the correct behaviour and it is also indistinguishable
 * from this function being broken, which is why `test/structured.test.ts`
 * exists and why the caps below log rather than truncating in silence.
 */
export function readStructured(
	raw: string | undefined | null,
): StructuredNode[] {
	if (!raw) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Hand-written JSON-LD is broken constantly and one bad block is not
		// worth a warning per document per query.
		return [];
	}

	const flattened: Record<string, unknown>[] = [];
	flatten(parsed, flattened);

	const nodes: StructuredNode[] = [];
	let bytes = 0;

	for (const candidate of flattened) {
		if (nodes.length >= MAX_NODES) {
			logger.debug(
				{ kept: nodes.length, seen: flattened.length },
				"structured data truncated at the node cap",
			);
			break;
		}
		const node = readNode(candidate, 0);
		if (!node) continue;

		const size = JSON.stringify(node).length;
		if (bytes + size > MAX_BYTES) {
			logger.debug(
				{ type: node.type, bytes, size },
				"structured data truncated at the byte cap",
			);
			break;
		}
		bytes += size;
		nodes.push(node);
	}

	return nodes;
}
