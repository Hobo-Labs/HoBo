import { appendFileSync, readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { pathToFileURL } from "node:url";
import {
	computeJobMemoryConfig,
	type JobMemoryConfig,
} from "../../packages/ci-gh-actions/src/isolated-worker/job-memory-config.ts";
import type { MemoryPeakHistories } from "../../packages/ci-gh-actions/src/isolated-worker/memory-peaks.ts";

export type { JobMemoryConfig };
export { computeJobMemoryConfig };

const MIB = 1024 * 1024;

export type JobMemoryHostSample = Readonly<{
	totalMemMb: number;
	cgroupMemoryMaxMb?: number | undefined;
}>;

export function jobMemoryEnvLines(config: JobMemoryConfig): string[] {
	return [
		`HOBO_NODE_OPTIONS=--max-old-space-size=${config.heapMb}`,
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

export function recentPeakMbForJob(
	jobName: string,
	peaksPath: string | undefined,
): number | undefined {
	if (!peaksPath || jobName === "") return undefined;
	try {
		// SAFETY: worker-owned JSON; shape matches MemoryPeakHistories.
		const parsed = JSON.parse(
			readFileSync(peaksPath, "utf8"),
		) as MemoryPeakHistories;
		const history = parsed[jobName];
		if (!history?.peaksMb?.length) return undefined;
		return Math.max(...history.peaksMb);
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
	const jobName = process.env.GITHUB_JOB ?? "";
	const recentPeakMb = recentPeakMbForJob(
		jobName,
		process.env.HOBO_CI_MEMORY_PEAKS_PATH,
	);
	const memoryInput: Parameters<typeof computeJobMemoryConfig>[0] = {
		limitMb,
		cpuCount: availableParallelism(),
	};
	if (recentPeakMb !== undefined) {
		memoryInput.recentPeakMb = recentPeakMb;
	}
	const config = computeJobMemoryConfig(memoryInput);
	appendFileSync(githubEnv, `${jobMemoryEnvLines(config).join("\n")}\n`);
	console.error(
		`memory-env: limitMb=${limitMb} heapMb=${config.heapMb} HOBO_TEST_MAX_WORKERS=${config.vitestMaxWorkers} HOBO_TURBO_CONCURRENCY=${config.turboConcurrency}`,
	);
}
