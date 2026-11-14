/** Allow a loaded runner to extend wall-clock test timeouts without reducing them. */
export function slow(
	minimumMs: number,
	env: Readonly<Record<string, string | undefined>> = process.env,
): number {
	const floor = Number(env.HOBO_TEST_TIMEOUT);
	return Number.isFinite(floor) && floor > minimumMs ? floor : minimumMs;
}

/** Time to let the spawned agent enter its loop before testing SIGTERM. */
export function agentRunDuration(
	env: Readonly<Record<string, string | undefined>> = process.env,
): number {
	const configured = env.HOBO_TEST_AGENT_RUN_MS;
	if (configured === undefined) return 8_000;
	const duration = Number(configured);
	if (!Number.isSafeInteger(duration) || duration < 8_000 || duration > 120_000)
		throw new Error(
			"HOBO_TEST_AGENT_RUN_MS must be an integer from 8000 to 120000",
		);
	return duration;
}
