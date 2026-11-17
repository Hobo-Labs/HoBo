export function lookupByJobName<T>(
	jobName: string,
	lookup: (name: string) => T | undefined,
): T | undefined {
	const exact = lookup(jobName);
	if (exact !== undefined) return exact;
	const leg = /^(.+) \([^()]+\)$/u.exec(jobName);
	return leg?.[1] === undefined ? undefined : lookup(leg[1]);
}
