export function slow(ms: number): number {
	const floor = Number(process.env.HOBO_TEST_TIMEOUT);
	return Number.isFinite(floor) && floor > ms ? floor : ms;
}
