/**
 * A per-test timeout a slow runner can still raise.
 *
 * A timeout passed to `it` overrides the config's, so `HOBO_TEST_TIMEOUT`
 * (which sets the default test and hook timeouts) could not lift it, and a
 * loaded runner failed these cases on time alone. This returns the larger of
 * the case's own budget and `HOBO_TEST_TIMEOUT`.
 */
export function slow(ms: number): number {
	const floor = Number(process.env.HOBO_TEST_TIMEOUT);
	return Number.isFinite(floor) && floor > ms ? floor : ms;
}
