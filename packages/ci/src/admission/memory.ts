/**
 * Memory admission: whether a job of a given size fits on a host now, keeping
 * a reserve for the host and a margin for allocation volatility. Pure; the
 * caller samples the host's available memory.
 */

export function memoryAdmitHeadroom(
	availableMb: number | undefined,
	requiredMb: number,
	reserveMb: number,
	volatilityMb: number,
	committedMb = 0,
): boolean {
	if (availableMb === undefined) return true;
	const safeCommitted =
		Number.isFinite(committedMb) && committedMb > 0
			? Math.floor(committedMb)
			: 0;
	return availableMb - safeCommitted - requiredMb >= reserveMb + volatilityMb;
}

/** How many `requiredMb` jobs fit with one host reserve + volatility margin. */
export function memoryAdmitParallelCount(
	availableMb: number | undefined,
	requiredMb: number,
	reserveMb: number,
	volatilityMb: number,
	cap: number,
): number {
	if (!Number.isInteger(cap) || cap <= 0) return 0;
	if (availableMb === undefined) return cap;
	let count = 0;
	while (
		count < cap &&
		memoryAdmitHeadroom(
			availableMb,
			requiredMb,
			reserveMb,
			volatilityMb,
			count * requiredMb,
		)
	)
		count += 1;
	return count;
}
