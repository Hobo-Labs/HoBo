export function capVitestWorkers(
	maxWorkers: number | undefined,
	env: Readonly<Record<string, string | undefined>> = process.env,
): number | undefined {
	const cap = Number(env.HOBO_TEST_MAX_WORKERS);
	if (!Number.isInteger(cap) || cap < 1) return maxWorkers;
	return maxWorkers === undefined ? cap : Math.min(maxWorkers, cap);
}
