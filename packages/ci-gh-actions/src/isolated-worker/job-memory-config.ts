export type JobMemoryConfig = Readonly<{
	heapMb: number;
	turboConcurrency: number;
	vitestMaxWorkers: number;
}>;

export function computeJobMemoryConfig(input: {
	limitMb: number;
	cpuCount: number;
}): JobMemoryConfig {
	const heapBudgetMb = input.limitMb - 768;
	const vitestMaxWorkers = Math.max(
		1,
		Math.min(input.cpuCount, Math.floor(heapBudgetMb / 1280) - 1),
	);
	return {
		heapMb: Math.min(3072, Math.floor(heapBudgetMb / (vitestMaxWorkers + 1))),
		turboConcurrency: 1,
		vitestMaxWorkers,
	};
}
