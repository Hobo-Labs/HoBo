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
