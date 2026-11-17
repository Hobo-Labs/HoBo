/** A deterministic comparison of ECMAScript string code units. */
export function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Retained only for replaying quotes created by pricing-rating/v1. */
export function compareLegacyLocale(left: string, right: string): number {
	return left.localeCompare(right);
}

export type TextComparison = (left: string, right: string) => number;
