/** ECMAScript string order is stable across process locales. */
export function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
