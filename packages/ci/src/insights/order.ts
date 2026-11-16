/**
 * Ordering shared by the insight reports. Text is compared by code unit, never
 * by the host's locale, so the same input gives the same report on every
 * machine.
 */

/** Negative when `left` sorts first, positive when `right` does, 0 when equal. */
export function compareText(left: string, right: string): number {
	if (left < right) return -1;
	return left > right ? 1 : 0;
}

/**
 * The same order with letter case ignored. Two texts that differ only in case
 * still sort one way, by their code units, so a sort stays repeatable.
 */
export function compareTextIgnoringCase(left: string, right: string): number {
	return (
		compareText(left.toLowerCase(), right.toLowerCase()) ||
		compareText(left, right)
	);
}
