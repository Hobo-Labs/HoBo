import { appendFileSync, readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { pathToFileURL } from "node:url";

const MIB = 1024 * 1024;

export type JobMemoryHostSample = Readonly<{
	totalMemMb: number;
	cgroupMemoryMaxMb?: number | undefined;
}>;

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

export function jobMemoryEnvLines(config: JobMemoryConfig): string[] {
	return [
		`NODE_OPTIONS=--max-old-space-size=${config.heapMb}`,
		`HOBO_TURBO_CONCURRENCY=${config.turboConcurrency}`,
		`HOBO_TEST_MAX_WORKERS=${config.vitestMaxWorkers}`,
	];
}

export function resolveJobMemoryLimitMb(
	env: Readonly<Record<string, string | undefined>>,
	host: JobMemoryHostSample,
): number {
	const value =
		host.cgroupMemoryMaxMb ??
		(env.HOBO_CI_JOB_MEMORY_MB === undefined
			? host.totalMemMb
			: Number(env.HOBO_CI_JOB_MEMORY_MB));
	if (!Number.isFinite(value) || value < 1)
		throw new Error(`invalid job memory limit: ${value}`);
	return Math.floor(value);
}

function readCgroupMemoryMaxMb(): number | undefined {
	try {
		const value = readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
		if (!/^\d+$/u.test(value)) return undefined;
		return Math.floor(Number(value) / MIB);
	} catch {
		return undefined;
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const githubEnv = process.env.GITHUB_ENV;
	if (!githubEnv) throw new Error("missing GITHUB_ENV");
	const limitMb = resolveJobMemoryLimitMb(process.env, {
		totalMemMb: Math.floor(totalmem() / MIB),
		cgroupMemoryMaxMb: readCgroupMemoryMaxMb(),
	});
	const config = computeJobMemoryConfig({
		limitMb,
		cpuCount: availableParallelism(),
	});
	appendFileSync(githubEnv, `${jobMemoryEnvLines(config).join("\n")}\n`);
	console.error(
		`memory-env: limitMb=${limitMb} heapMb=${config.heapMb} HOBO_TEST_MAX_WORKERS=${config.vitestMaxWorkers} HOBO_TURBO_CONCURRENCY=${config.turboConcurrency}`,
	);
}
