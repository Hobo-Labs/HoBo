export function compareText(left: string, right: string): number {
	if (left < right) return -1;
	return left > right ? 1 : 0;
}

export function compareTextIgnoringCase(left: string, right: string): number {
	return (
		compareText(left.toLowerCase(), right.toLowerCase()) ||
		compareText(left, right)
	);
}
