/**
 * The query-plane event contract.
 *
 * This is the same shape `apps/search-web/lib/search/types.ts` consumes. The
 * two are deliberately duplicated rather than shared through a package: the
 * surface and this service each build standalone from their own subtree
 * mirror, where a `workspace:` dependency cannot resolve, and a published
 * package would put an npm release between every contract change and the two
 * apps that need it.
 *
 * Duplication has a cost and it is worth naming: these two files can drift.
 * The mitigation is that they are small, that the surface ignores fields it
 * does not know, and that `test/events.test.ts` asserts the wire encoding
 * rather than the type — a drift that matters shows up as a frame the surface
 * cannot parse, not as a silent mismatch.
 *
 * When the contract changes, change it here first: this side produces the
 * events, and a producer that emits something the consumer has not learned to
 * read yet is the recoverable direction.
 */

export type StageId =
	| "route"
	| "search"
	| "capability"
	| "read"
	| "rank"
	| "compose";

export type StageState = "pending" | "active" | "done";

export type Stage = {
	id: StageId;
	state: StageState;
	label: string;
};

export type Intent = "navigational" | "informational" | "discovery" | "action";

export type Span = { kind: "text"; text: string } | { kind: "cite"; n: number };

export type ComparisonRow = { label: string; cells: string[] };

export type CapabilityRef = {
	domain: string;
	invocationName: string;
	effects:
		| "read"
		| "write-reversible"
		| "write-irreversible"
		| "financial"
		| "unknown";
	/**
	 * Ours to decide, never the manifest's. A transport we do not speak or an
	 * effects tier above `read` is still indexed and still shown; it simply
	 * cannot be invoked from here.
	 */
	callable: boolean;
};

export type AnswerBlock =
	| { kind: "answer"; id: string; spans: Span[] }
	| { kind: "note"; id: string; label: string; spans: Span[] }
	| {
			kind: "comparison";
			id: string;
			label: string;
			columns: string[];
			rows: ComparisonRow[];
	  }
	| {
			kind: "action";
			id: string;
			label: string;
			prompt: string;
			cta: string;
			capability?: CapabilityRef;
	  }
	| { kind: "suggestions"; id: string; label: string; queries: string[] };

export type Passage = { id: string; text: string; cited: boolean };

export type Source = {
	id: string;
	n: number;
	domain: string;
	path: string;
	url: string;
	title: string;
	swatch: string;
	capturedLabel?: string;
	passages: Passage[];
};

export type SearchEvent =
	| { type: "intent"; intent: Intent }
	| { type: "stage"; stage: Stage }
	| { type: "crawled"; count: number }
	| { type: "source"; source: Source }
	| { type: "block"; block: AnswerBlock }
	| { type: "done" }
	| { type: "error"; message: string };

/** One server-sent-events frame. */
export function frame(event: SearchEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}
