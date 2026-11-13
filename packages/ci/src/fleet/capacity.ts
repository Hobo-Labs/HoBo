/**
 * Memory headroom arithmetic for box admission: whether a job of a given
 * size fits under the host reserve and volatility margin, and how many fit
 * side by side.
 *
 * No capacity record leaves the box: whether the fleet can take a run is the
 * relay's to decide (ADR-0180).
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
