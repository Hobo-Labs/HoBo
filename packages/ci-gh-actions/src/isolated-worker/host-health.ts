/**
 * Host health for the box worker: is this machine fit to take more work?
 *
 * Memory and storage admission each answer for one job at one moment. Nothing
 * looked at the machine as a whole: a box could be swapping, out of inodes on
 * one filesystem and at four times its CPU count in load, and still be the
 * fleet's first choice for the next job. Jobs then start, stall in setup, and
 * die with their runner, and a dead runner costs a whole workflow run.
 *
 * This samples the three resources a job cannot do without, classifies the
 * host, and holds the verdict steady so one bad second neither condemns the
 * box nor one good second clears it:
 *
 *   ok         take work
 *   pressured  take work, and clean up now instead of at the next interval
 *   critical   the fleet should send new work elsewhere until it recovers
 *
 * Pure classification and a small monitor; the daemon supplies the sampler
 * and decides what each state does.
 */

import type { WorkerFileSystemStats } from "./storage-admission.js";

export type HostStorageSample = Readonly<{
	path: string;
	/** Free fraction of bytes on the filesystem holding `path`, 0 to 1. */
	freeBytesFraction: number;
	/** Free fraction of inodes, 0 to 1. */
	freeInodesFraction: number;
}>;

export type HostHealthSample = Readonly<{
	/** One-minute load average divided by online CPUs. */
	loadPerCpu: number;
	/** MemAvailable over MemTotal, 0 to 1. Absent when it cannot be read. */
	memoryAvailableFraction?: number;
	storage: readonly HostStorageSample[];
}>;

export type HostHealthState = "ok" | "pressured" | "critical";

export type HostHealthThresholds = Readonly<{
	/** Load per CPU at or above which the host is pressured / critical. */
	loadPerCpu: Readonly<{ pressured: number; critical: number }>;
	/** Available memory fraction at or below which it is pressured / critical. */
	memoryAvailableFraction: Readonly<{ pressured: number; critical: number }>;
	/** Free bytes or inodes fraction at or below which it is pressured / critical. */
	storageFreeFraction: Readonly<{ pressured: number; critical: number }>;
}>;

/**
 * Job containers are CPU-bound test and build work: 1.5 runnable tasks a core
 * means every job is already slowed by half, and 3 means a 20-minute job
 * budget is being spent waiting for a core. Storage at 15% free is where the
 * worker's own collection starts to matter; 5% is where a checkout fails.
 */
// public-contract: operators tune the box worker against these defaults.
export const DEFAULT_HOST_HEALTH_THRESHOLDS = {
	loadPerCpu: { pressured: 1.5, critical: 3 },
	memoryAvailableFraction: { pressured: 0.15, critical: 0.07 },
	storageFreeFraction: { pressured: 0.15, critical: 0.05 },
} as const satisfies HostHealthThresholds;

export type HostHealthReason =
	| "load"
	| "memory"
	| "storage-bytes"
	| "storage-inodes";

export type HostHealthVerdict = Readonly<{
	state: HostHealthState;
	/** Resources at or past the verdict's own level. */
	reasons: readonly HostHealthReason[];
}>;

const RANK = { ok: 0, pressured: 1, critical: 2 } as const satisfies Record<
	HostHealthState,
	number
>;

function atLeast(
	value: number,
	limits: Readonly<{ pressured: number; critical: number }>,
): HostHealthState {
	if (value >= limits.critical) return "critical";
	return value >= limits.pressured ? "pressured" : "ok";
}

function atMost(
	value: number,
	limits: Readonly<{ pressured: number; critical: number }>,
): HostHealthState {
	if (value <= limits.critical) return "critical";
	return value <= limits.pressured ? "pressured" : "ok";
}

/** One sample's verdict, with no memory of earlier samples. */
export function classifyHostHealth(
	sample: HostHealthSample,
	thresholds: HostHealthThresholds = DEFAULT_HOST_HEALTH_THRESHOLDS,
): HostHealthVerdict {
	const levels: [HostHealthReason, HostHealthState][] = [
		["load", atLeast(sample.loadPerCpu, thresholds.loadPerCpu)],
	];
	if (sample.memoryAvailableFraction !== undefined)
		levels.push([
			"memory",
			atMost(
				sample.memoryAvailableFraction,
				thresholds.memoryAvailableFraction,
			),
		]);
	for (const entry of sample.storage) {
		levels.push([
			"storage-bytes",
			atMost(entry.freeBytesFraction, thresholds.storageFreeFraction),
		]);
		levels.push([
			"storage-inodes",
			atMost(entry.freeInodesFraction, thresholds.storageFreeFraction),
		]);
	}
	const state = levels.reduce<HostHealthState>(
		(worst, [, level]) => (RANK[level] > RANK[worst] ? level : worst),
		"ok",
	);
	return {
		state,
		reasons:
			state === "ok"
				? []
				: [
						...new Set(
							levels
								.filter(([, level]) => level === state)
								.map(([reason]) => reason),
						),
					],
	};
}

export type HostHealthLog = (
	event: "hobo_ci_host_health" | "hobo_ci_host_health_sample_failed",
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;

function worstStorage(sample: HostHealthSample) {
	return sample.storage.reduce(
		(worst, entry) => ({
			freeBytesFraction: Math.min(
				worst.freeBytesFraction,
				entry.freeBytesFraction,
			),
			freeInodesFraction: Math.min(
				worst.freeInodesFraction,
				entry.freeInodesFraction,
			),
		}),
		{ freeBytesFraction: 1, freeInodesFraction: 1 },
	);
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Holds the host's state between samples.
 *
 * Going up needs `escalateAfter` consecutive samples at the worse level, and
 * coming down needs `recoverAfter` at the better one: load and available
 * memory both swing within a single job, and a fleet that reroutes on every
 * swing is worse than one that never does. A failed sample changes nothing.
 */
export function createHostHealthMonitor(options: {
	sample: () => Promise<HostHealthSample>;
	thresholds?: HostHealthThresholds;
	/** Minimum gap between samples. */
	intervalMs?: number;
	escalateAfter?: number;
	recoverAfter?: number;
	/** A steady state is logged again this often. */
	reportEveryMs?: number;
	now?: () => number;
	log?: HostHealthLog;
	/** Called when the host enters `pressured` or `critical`. */
	onPressure?: (verdict: HostHealthVerdict) => void;
}) {
	const intervalMs = options.intervalMs ?? 10_000;
	const escalateAfter = options.escalateAfter ?? 3;
	const recoverAfter = options.recoverAfter ?? 6;
	const reportEveryMs = options.reportEveryMs ?? 5 * 60_000;
	const now = options.now ?? Date.now;
	let held: HostHealthVerdict = { state: "ok", reasons: [] };
	let pending: HostHealthState = "ok";
	let streak = 0;
	let sampledAtMs: number | undefined;
	let reportedAtMs: number | undefined;

	function report(sample: HostHealthSample, previous: HostHealthState): void {
		reportedAtMs = now();
		const storage = worstStorage(sample);
		options.log?.("hobo_ci_host_health", {
			state: held.state,
			previous,
			reasons: held.reasons.join(","),
			loadPerCpu: round(sample.loadPerCpu),
			memoryAvailableFraction: round(sample.memoryAvailableFraction ?? -1),
			storageFreeBytesFraction: round(storage.freeBytesFraction),
			storageFreeInodesFraction: round(storage.freeInodesFraction),
		});
	}

	/** Samples at most once per interval; safe to call on every tick. */
	async function observe(): Promise<HostHealthVerdict> {
		const at = now();
		if (sampledAtMs !== undefined && at - sampledAtMs < intervalMs) return held;
		sampledAtMs = at;
		let sample: HostHealthSample;
		try {
			sample = await options.sample();
		} catch (error) {
			options.log?.("hobo_ci_host_health_sample_failed", {
				message: error instanceof Error ? error.message : "unknown",
			});
			return held;
		}
		const verdict = classifyHostHealth(sample, options.thresholds);
		const previous = held.state;
		if (verdict.state === held.state) {
			// Same level; the resources behind it may have changed.
			held = verdict;
			pending = verdict.state;
			streak = 0;
		} else {
			streak = verdict.state === pending ? streak + 1 : 1;
			pending = verdict.state;
			const needed =
				RANK[verdict.state] > RANK[held.state] ? escalateAfter : recoverAfter;
			if (streak >= needed) {
				held = verdict;
				streak = 0;
			}
		}
		const changed = held.state !== previous;
		if (changed && held.state !== "ok") options.onPressure?.(held);
		if (
			changed ||
			reportedAtMs === undefined ||
			(held.state !== "ok" && at - reportedAtMs >= reportEveryMs)
		)
			report(sample, previous);
		return held;
	}

	return {
		observe,
		/** The held verdict, without sampling. */
		current: (): HostHealthVerdict => held,
	};
}

export type HostHealthMonitor = ReturnType<typeof createHostHealthMonitor>;

/** A filesystem that reports no inodes (some overlay and network mounts) is not short of them. */
function fraction(free: number, total: number): number {
	if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0) return 1;
	return Math.min(1, Math.max(0, free / total));
}

/** Builds a sample from the host facts the daemon already has ways to read. */
export async function readHostHealthSample(host: {
	loadAverage1m: number;
	cpus: number;
	memory?: Readonly<{ availableMb: number; totalMb: number }> | undefined;
	paths: readonly string[];
	statfs: (path: string) => Promise<WorkerFileSystemStats>;
}): Promise<HostHealthSample> {
	const storage = await Promise.all(
		[...new Set(host.paths)].map(async (path) => {
			const stats = await host.statfs(path);
			return {
				path,
				freeBytesFraction: fraction(stats.bfree, stats.blocks),
				freeInodesFraction: fraction(stats.ffree, stats.files),
			};
		}),
	);
	const base = {
		loadPerCpu: host.loadAverage1m / Math.max(1, host.cpus),
		storage,
	};
	return host.memory === undefined
		? base
		: {
				...base,
				memoryAvailableFraction: fraction(
					host.memory.availableMb,
					host.memory.totalMb,
				),
			};
}
