export function slow(minimumTimeout: number): number {
	const configuredTimeout = Number(process.env.HOBO_TEST_TIMEOUT);
	return Number.isFinite(configuredTimeout) &&
		configuredTimeout > minimumTimeout
		? configuredTimeout
		: minimumTimeout;
}
