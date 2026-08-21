/**
 * Unit conversion, recognised and computed without a model.
 *
 * A conversion is the one query shape this engine can answer completely on its
 * own, and until now it answered it worst. `1 kg in pound` classified as
 * `information`, retrieved news articles, and had a language model write "I am
 * sorry, but the provided sources do not contain information about converting
 * kilograms to pounds. They focus on news related to an earthquake in
 * Colombia." Four Vespa queries, up to two paid provider calls and three model
 * calls, to produce a worse answer than arithmetic.
 *
 * So this sits in the structural pass beside the hostname and entity-registry
 * rules, for the same stated reason: *"a hostname is not a guess... nothing a
 * model says would improve either."* Neither is `1 kg in pound`.
 *
 * ## The table is duplicated, deliberately
 *
 * `apps/search-web/lib/search/modules/utility.ts` holds the same units, because
 * the surface renders the converter client-side — the design's own line is
 * `COMPUTED LOCALLY · NO SOURCES NEEDED`. Sharing them would mean either a
 * `workspace:` dependency the surface's subtree mirror cannot resolve, or an
 * npm release of `@cheela/search-core` between every unit added and the two
 * apps that need it.
 *
 * The duplication is safe in a way the egress client's would not be: both sides
 * parse the *same query text*, so a drift shows up as one side converting and
 * the other not, immediately and visibly, rather than as a security hole nobody
 * can see. And this side answering in prose means a unit the surface lacks
 * still produces a correct answer rather than a blank card.
 */

type Unit = {
	/** How many base units one of these is. Unused for temperature. */
	factor: number;
	dimension: string;
	label: string;
};

const UNITS: Record<string, Unit> = {};

function define(unit: Unit, ...names: string[]): void {
	for (const name of names) UNITS[name] = unit;
}

// -- Data. Base: the byte. ---------------------------------------------------
define({ factor: 1, dimension: "data", label: "bytes" }, "b", "byte", "bytes");
define(
	{ factor: 1e3, dimension: "data", label: "kilobytes" },
	"kb",
	"kilobyte",
	"kilobytes",
);
define(
	{ factor: 1e6, dimension: "data", label: "megabytes" },
	"mb",
	"megabyte",
	"megabytes",
);
define(
	{ factor: 1e9, dimension: "data", label: "gigabytes" },
	"gb",
	"gigabyte",
	"gigabytes",
);
define(
	{ factor: 1e12, dimension: "data", label: "terabytes" },
	"tb",
	"terabyte",
	"terabytes",
);
define(
	{ factor: 1e15, dimension: "data", label: "petabytes" },
	"pb",
	"petabyte",
	"petabytes",
);
define(
	{ factor: 1024, dimension: "data", label: "kibibytes" },
	"kib",
	"kibibyte",
	"kibibytes",
);
define(
	{ factor: 1024 ** 2, dimension: "data", label: "mebibytes" },
	"mib",
	"mebibyte",
	"mebibytes",
);
define(
	{ factor: 1024 ** 3, dimension: "data", label: "gibibytes" },
	"gib",
	"gibibyte",
	"gibibytes",
);
define(
	{ factor: 1024 ** 4, dimension: "data", label: "tebibytes" },
	"tib",
	"tebibyte",
	"tebibytes",
);

// -- Length. Base: the metre. ------------------------------------------------
define(
	{ factor: 0.001, dimension: "length", label: "millimetres" },
	"mm",
	"millimetre",
	"millimetres",
	"millimeter",
	"millimeters",
);
define(
	{ factor: 0.01, dimension: "length", label: "centimetres" },
	"cm",
	"centimetre",
	"centimetres",
	"centimeter",
	"centimeters",
);
define(
	{ factor: 1, dimension: "length", label: "metres" },
	"m",
	"metre",
	"metres",
	"meter",
	"meters",
);
define(
	{ factor: 1000, dimension: "length", label: "kilometres" },
	"km",
	"kilometre",
	"kilometres",
	"kilometer",
	"kilometers",
);
define(
	{ factor: 0.0254, dimension: "length", label: "inches" },
	"in",
	"inch",
	"inches",
);
define(
	{ factor: 0.3048, dimension: "length", label: "feet" },
	"ft",
	"foot",
	"feet",
);
define(
	{ factor: 0.9144, dimension: "length", label: "yards" },
	"yd",
	"yard",
	"yards",
);
define(
	{ factor: 1609.344, dimension: "length", label: "miles" },
	"mi",
	"mile",
	"miles",
);

// -- Mass. Base: the gram. ---------------------------------------------------
define({ factor: 1, dimension: "mass", label: "grams" }, "g", "gram", "grams");
define(
	{ factor: 1000, dimension: "mass", label: "kilograms" },
	"kg",
	"kilo",
	"kilos",
	"kilogram",
	"kilograms",
);
define(
	{ factor: 1e6, dimension: "mass", label: "tonnes" },
	"t",
	"tonne",
	"tonnes",
);
define(
	{ factor: 28.349523125, dimension: "mass", label: "ounces" },
	"oz",
	"ounce",
	"ounces",
);
define(
	{ factor: 453.59237, dimension: "mass", label: "pounds" },
	"lb",
	"lbs",
	"pound",
	"pounds",
);
define(
	{ factor: 6350.29318, dimension: "mass", label: "stone" },
	"st",
	"stone",
	"stones",
);

// -- Time. Base: the second. -------------------------------------------------
define(
	{ factor: 0.001, dimension: "time", label: "milliseconds" },
	"ms",
	"millisecond",
	"milliseconds",
);
define(
	{ factor: 1, dimension: "time", label: "seconds" },
	"s",
	"sec",
	"secs",
	"second",
	"seconds",
);
define(
	{ factor: 60, dimension: "time", label: "minutes" },
	"min",
	"mins",
	"minute",
	"minutes",
);
define(
	{ factor: 3600, dimension: "time", label: "hours" },
	"h",
	"hr",
	"hrs",
	"hour",
	"hours",
);
define(
	{ factor: 86_400, dimension: "time", label: "days" },
	"d",
	"day",
	"days",
);
define(
	{ factor: 604_800, dimension: "time", label: "weeks" },
	"wk",
	"week",
	"weeks",
);

// -- Temperature. Not a factor; see the two functions below. ------------------
define(
	{ factor: 0, dimension: "temperature", label: "Celsius" },
	"c",
	"°c",
	"celsius",
	"centigrade",
);
define(
	{ factor: 0, dimension: "temperature", label: "Fahrenheit" },
	"f",
	"°f",
	"fahrenheit",
);
define({ factor: 0, dimension: "temperature", label: "Kelvin" }, "k", "kelvin");

const toCelsius = (value: number, label: string): number =>
	label === "Fahrenheit"
		? ((value - 32) * 5) / 9
		: label === "Kelvin"
			? value - 273.15
			: value;

const fromCelsius = (value: number, label: string): number =>
	label === "Fahrenheit"
		? (value * 9) / 5 + 32
		: label === "Kelvin"
			? value + 273.15
			: value;

/**
 * `1 kg in pound`, `450 gb to tb`, `180 c to f`, `3 hours in minutes`.
 *
 * Deliberately strict. Anything that is not unambiguously a conversion falls
 * through to the model and then to a real search — a query this misread would
 * replace a page of results with a wrong number, which is a far worse failure
 * than missing a conversion.
 */
const SHAPE =
	/^\s*(-?[\d.,]+)\s*([a-zA-Z°]+)\s+(?:to|in|as|into)\s+([a-zA-Z°]+)\s*$/;

export type Conversion = {
	amount: number;
	from: string;
	to: string;
	converted: number;
	dimension: string;
};

export function parseConversion(query: string): Conversion | null {
	const match = SHAPE.exec(query);
	if (!match) return null;

	const amount = Number(match[1].replace(/,/g, ""));
	if (!Number.isFinite(amount)) return null;

	const from = UNITS[match[2].toLowerCase()];
	const to = UNITS[match[3].toLowerCase()];
	// Same dimension or it is not a conversion. "10 kg to miles" is a question
	// about nothing, and answering it with a number would be worse than not.
	if (!from || !to || from.dimension !== to.dimension || from === to) {
		return null;
	}

	const converted =
		from.dimension === "temperature"
			? fromCelsius(toCelsius(amount, from.label), to.label)
			: (amount * from.factor) / to.factor;

	if (!Number.isFinite(converted)) return null;

	return {
		amount,
		from: from.label,
		to: to.label,
		converted,
		dimension: from.dimension,
	};
}

/** Enough digits to be exact where it can be, without printing float noise. */
function present(value: number): string {
	const magnitude = Math.abs(value);
	const digits =
		magnitude === 0 ? 0 : magnitude < 1 ? 6 : magnitude < 1000 ? 4 : 2;
	return Number(value.toFixed(digits)).toLocaleString("en-US", {
		maximumFractionDigits: digits,
	});
}

/**
 * The answer, as a sentence.
 *
 * Written here as well as rendered by the surface's module, so a client that is
 * not our surface — or a unit the surface's own table happens to lack — still
 * gets the right number rather than an empty response.
 */
export function answerConversion(conversion: Conversion): string {
	const unit = (value: number, label: string) =>
		// "1 kilograms" reads as a bug even though the number is right.
		Math.abs(value) === 1 ? label.replace(/s$/, "") : label;
	return (
		`${present(conversion.amount)} ${unit(conversion.amount, conversion.from)} ` +
		`is ${present(conversion.converted)} ${unit(conversion.converted, conversion.to)}.`
	);
}
