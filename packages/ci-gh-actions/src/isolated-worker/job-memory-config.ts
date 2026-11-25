export type JobMemoryConfig = Readonly<{
	heapMb: number;
	turboConcurrency: number;
	vitestMaxWorkers: number;
}>;

/** Standard-class floor for raising turbo above one slot. */
export const MAIN_WORKSPACE_MEMORY_FLOOR_MB = 4096;

/** Estimated native RSS per extra turbo task on a standard shard. */
export const TURBO_PARALLEL_SLOT_MB = 896;

export function computeTurboConcurrency(input: {
	limitMb: number;
	cpuCount: number;
	vitestMaxWorkers: number;
	heapMb: number;
	recentPeakMb?: number;
}): number {
	if (input.limitMb < MAIN_WORKSPACE_MEMORY_FLOOR_MB) return 1;
	const nodeBudgetMb = (input.vitestMaxWorkers + 1) * input.heapMb + 768;
	const usedMb = input.recentPeakMb
		? Math.ceil(input.recentPeakMb * 1.15)
		: nodeBudgetMb;
	const slackMb = input.limitMb - usedMb;
	const extra = Math.floor(slackMb / TURBO_PARALLEL_SLOT_MB);
	const maxExtra = Math.max(0, Math.min(input.cpuCount - 1, 3));
	return Math.max(1, 1 + Math.min(extra, maxExtra));
}

export function computeJobMemoryConfig(input: {
	limitMb: number;
	cpuCount: number;
	recentPeakMb?: number;
}): JobMemoryConfig {
	const heapBudgetMb = input.limitMb - 768;
	const vitestMaxWorkers = Math.max(
		1,
		Math.min(input.cpuCount, Math.floor(heapBudgetMb / 1280) - 1),
	);
	const heapMb = Math.min(
		3072,
		Math.floor(heapBudgetMb / (vitestMaxWorkers + 1)),
	);
	const turboConcurrencyInput: Parameters<typeof computeTurboConcurrency>[0] = {
		limitMb: input.limitMb,
		cpuCount: input.cpuCount,
		vitestMaxWorkers,
		heapMb,
	};
	if (input.recentPeakMb !== undefined) {
		turboConcurrencyInput.recentPeakMb = input.recentPeakMb;
	}
	const turboConcurrency = computeTurboConcurrency(turboConcurrencyInput);
	return {
		heapMb,
		turboConcurrency,
		vitestMaxWorkers,
	};
}
