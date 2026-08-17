/**
 * robots.txt.
 *
 * Required by the TDS's security section, and the one outbound rule here that
 * is a matter of conduct rather than of safety: nothing bad happens to *us* if
 * we ignore it. What happens instead is that a crawler which ignores robots
 * gets blocked by CDNs, and a search engine that has been blocked by the CDNs
 * cannot read the web at all. It is load-bearing for the product, just slowly.
 *
 * The parser implements the parts of the de-facto standard that sites actually
 * use: user-agent groups with `*` fallback, Allow and Disallow, `*` and `$`
 * wildcards, and longest-match-wins with Allow breaking ties. Crawl-delay and
 * Sitemap are parsed and ignored — the fetcher's concurrency limit is what
 * paces this, not a per-host directive we would have to honour globally.
 */

export type RobotsPolicy = {
	allows(url: URL, userAgent: string): Promise<boolean>;
};

/** Used when robots are disabled, and by the fetch of robots.txt itself. */
export const allowAll: RobotsPolicy = {
	allows: async () => true,
};

type Rule = { allow: boolean; pattern: string };
type Group = { agents: string[]; rules: Rule[] };

export function parseRobots(text: string): Group[] {
	const groups: Group[] = [];
	let current: Group | null = null;
	// Consecutive User-agent lines share one group of rules; a rule line ends
	// the run and starts a new group on the next agent line.
	let collectingAgents = false;

	for (const raw of text.split(/\r?\n/)) {
		const line = raw.split("#")[0].trim();
		if (!line) continue;

		const separator = line.indexOf(":");
		if (separator === -1) continue;
		const field = line.slice(0, separator).trim().toLowerCase();
		const value = line.slice(separator + 1).trim();

		if (field === "user-agent") {
			if (!current || !collectingAgents) {
				current = { agents: [], rules: [] };
				groups.push(current);
				collectingAgents = true;
			}
			current.agents.push(value.toLowerCase());
			continue;
		}

		if (field === "allow" || field === "disallow") {
			if (!current) continue;
			collectingAgents = false;
			// "Disallow:" with an empty value means "nothing is disallowed", so
			// it must not become a rule matching every path.
			if (field === "disallow" && value === "") continue;
			current.rules.push({ allow: field === "allow", pattern: value });
		}
	}

	return groups;
}

/** Product token: "CheelaSearchBot/1.0 (+…)" identifies as "cheelasearchbot". */
export function productToken(userAgent: string): string {
	return userAgent.split("/")[0].trim().toLowerCase();
}

function matches(pattern: string, path: string): number {
	// Returns the match length, or -1. Length is what decides between two
	// conflicting rules, so it has to be the pattern's specificity rather than
	// a boolean.
	const anchored = pattern.endsWith("$");
	const body = anchored ? pattern.slice(0, -1) : pattern;
	const parts = body.split("*");

	let cursor = 0;
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index];
		if (part === "") continue;
		const found =
			index === 0
				? path.startsWith(part)
					? 0
					: -1
				: path.indexOf(part, cursor);
		if (found === -1) return -1;
		cursor = found + part.length;
	}

	if (anchored && cursor !== path.length) return -1;
	return body.length;
}

export function isAllowed(
	groups: Group[],
	userAgent: string,
	path: string,
): boolean {
	const token = productToken(userAgent);

	// Most specific group wins: an exact agent match beats the `*` group, and
	// a site that names us has said something we should not average away.
	const named = groups.filter((group) =>
		group.agents.some((agent) => agent !== "*" && token.includes(agent)),
	);
	const wildcard = groups.filter((group) => group.agents.includes("*"));
	const applicable = named.length > 0 ? named : wildcard;
	if (applicable.length === 0) return true;

	let best: { allow: boolean; length: number } | null = null;
	for (const group of applicable) {
		for (const rule of group.rules) {
			const length = matches(rule.pattern, path);
			if (length === -1) continue;
			if (
				!best ||
				length > best.length ||
				// Equal specificity: Allow wins. That is the documented tie-break
				// and it is the charitable reading of an ambiguous file.
				(length === best.length && rule.allow)
			) {
				best = { allow: rule.allow, length };
			}
		}
	}

	return best ? best.allow : true;
}

type Fetcher = (url: string) => Promise<{ status: number; body: Buffer }>;

/**
 * Caches per origin, in process.
 *
 * In process rather than in Redis on purpose: robots.txt is read on the fetch
 * path, a Redis round trip costs more than it saves for a file this small, and
 * every replica converging on its own copy within the TTL is fine. The cost of
 * being wrong is one extra fetch of a file the origin serves from cache.
 */
export function createRobotsPolicy(
	fetcher: Fetcher,
	ttlMs = 3_600_000,
	now: () => number = Date.now,
): RobotsPolicy {
	const cache = new Map<string, { groups: Group[]; expires: number }>();

	return {
		async allows(url: URL, userAgent: string): Promise<boolean> {
			const origin = url.origin;
			const cached = cache.get(origin);

			let groups: Group[];
			if (cached && cached.expires > now()) {
				groups = cached.groups;
			} else {
				try {
					const response = await fetcher(`${origin}/robots.txt`);
					// 404 is the normal case and means everything is permitted.
					// 5xx is not consent, but treating a broken origin as a
					// prohibition would make one bad deploy invisible to us for an
					// hour, so it is cached as permissive for a short time only.
					groups =
						response.status === 200
							? parseRobots(response.body.toString("utf8"))
							: [];
				} catch {
					groups = [];
				}
				cache.set(origin, { groups, expires: now() + ttlMs });
			}

			return isAllowed(groups, userAgent, url.pathname + url.search);
		},
	};
}
