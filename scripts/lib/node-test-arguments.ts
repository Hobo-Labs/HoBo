/** Keep node:test within the same worker budget as the Vitest lane. */
export function nodeTestArguments(
	files: readonly string[],
	maxWorkers: number,
): string[] {
	return [
		"--import",
		"tsx",
		"--test",
		`--test-concurrency=${maxWorkers}`,
		...files,
	];
}
