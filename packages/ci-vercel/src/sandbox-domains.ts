/** Only documented runner service suffixes may be configured as wildcards. */
const runnerWildcardSuffixes = new Set([
	"actions.githubusercontent.com",
	"blob.core.windows.net",
]);

function validHostname(hostname: string): boolean {
	return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
		hostname,
	);
}

/** A bare catch-all is never permitted: it can bypass Sandbox forwarding. */
export function validSandboxDomainPattern(pattern: string): boolean {
	if (pattern.startsWith("*.")) {
		const suffix = pattern.slice(2);
		return runnerWildcardSuffixes.has(suffix) && validHostname(suffix);
	}
	return validHostname(pattern);
}

/** Validate the exact domain list accepted for Sandbox forwarding. */
export function validateSandboxDomains(domains: readonly string[]): void {
	if (domains.length === 0 || domains.length > 100)
		throw new Error("sandbox requires explicit allowed domains");
	if (
		new Set(domains).size !== domains.length ||
		domains.some((domain) => !validSandboxDomainPattern(domain))
	)
		throw new Error("invalid or repeated sandbox destination");
}

/** A wildcard matches subdomains only, with a whole-label boundary. */
export function matchesSandboxDomain(
	hostname: string,
	patterns: ReadonlySet<string>,
): boolean {
	if (!validHostname(hostname)) return false;
	if (patterns.has(hostname)) return true;
	for (const pattern of patterns) {
		if (pattern.startsWith("*.") && hostname.endsWith(pattern.slice(1)))
			return true;
	}
	return false;
}
