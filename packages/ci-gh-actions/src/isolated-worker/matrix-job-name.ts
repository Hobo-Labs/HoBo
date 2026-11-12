/**
 * GitHub names each leg of a matrix job `<job name> (<matrix values>)`, for
 * example `Publish GHCR images (tagged release) (hobo-cli)`. Lookups keyed by
 * the job's own name try the full name first (some names end in parentheses
 * themselves) and then the name without its last parenthesised suffix.
 */
export function lookupByJobName<T>(
	jobName: string,
	lookup: (name: string) => T | undefined,
): T | undefined {
	const exact = lookup(jobName);
	if (exact !== undefined) return exact;
	const leg = /^(.+) \([^()]+\)$/u.exec(jobName);
	return leg?.[1] === undefined ? undefined : lookup(leg[1]);
}
