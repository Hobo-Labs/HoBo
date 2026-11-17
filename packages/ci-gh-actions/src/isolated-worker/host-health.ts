import type { WorkerFileSystemStats } from "./storage-admission.js";

export type HostStorageSample = Readonly<{
	path: string;
	freeBytesFraction: number;
	freeInodesFraction: number;
}>;

export type HostHealthSample = Readonly<{
	loadPerCpu: number;
	memoryAvailableFraction?: number;
	storage: readonly HostStorageSample[];
}>;

export type HostHealthState = "ok" | "pressured" | "critical";

export type HostHealthThresholds = Readonly<{
	loadPerCpu: Readonly<{ pressured: number; critical: number }>;
	memoryAvailableFraction: Readonly<{ pressured: number; critical: number }>;
	storageFreeFraction: Readonly<{ pressured: number; critical: number }>;
}>;

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

export function createHostHealthMonitor(options: {
	sample: () => Promise<HostHealthSample>;
	thresholds?: HostHealthThresholds;
	intervalMs?: number;
	escalateAfter?: number;
	recoverAfter?: number;
	reportEveryMs?: number;
	sampleTimeoutMs?: number;
	now?: () => number;
	log?: HostHealthLog;
	onPressure?: (verdict: HostHealthVerdict) => void;
}) {
	const intervalMs = options.intervalMs ?? 10_000;
	const escalateAfter = options.escalateAfter ?? 3;
	const recoverAfter = options.recoverAfter ?? 6;
	const reportEveryMs = options.reportEveryMs ?? 5 * 60_000;
	const sampleTimeoutMs = options.sampleTimeoutMs ?? 2_000;
	const now = options.now ?? Date.now;
	let held: HostHealthVerdict = { state: "ok", reasons: [] };
	let run:
		| { direction: 1 | -1; length: number; bound: HostHealthVerdict }
		| undefined;

	function bounded(): Promise<HostHealthSample> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(
				() => reject(new Error("host health sample timed out")),
				sampleTimeoutMs,
			);
		});
		return Promise.race([options.sample(), timeout]).finally(() =>
			clearTimeout(timer),
		);
	}
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

	async function observe(): Promise<HostHealthVerdict> {
		const at = now();
		if (sampledAtMs !== undefined && at - sampledAtMs < intervalMs) return held;
		sampledAtMs = at;
		let sample: HostHealthSample;
		try {
			sample = await bounded();
		} catch (error) {
			options.log?.("hobo_ci_host_health_sample_failed", {
				message: error instanceof Error ? error.message : "unknown",
			});
			return held;
		}
		const verdict = classifyHostHealth(sample, options.thresholds);
		const previous = held.state;
		const side = Math.sign(RANK[verdict.state] - RANK[held.state]);
		if (side === 0) {
			held = verdict;
			run = undefined;
		} else {
			const direction = side > 0 ? 1 : -1;
			const continuing = run?.direction === direction ? run : undefined;
			const closer =
				continuing === undefined ||
				(RANK[verdict.state] - RANK[continuing.bound.state]) * direction < 0;
			run = {
				direction,
				length: (continuing?.length ?? 0) + 1,
				bound: closer || continuing === undefined ? verdict : continuing.bound,
			};
			if (run.length >= (direction > 0 ? escalateAfter : recoverAfter)) {
				held = run.bound;
				run = undefined;
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
		current: (): HostHealthVerdict => held,
	};
}

export type HostHealthMonitor = ReturnType<typeof createHostHealthMonitor>;

function fraction(free: number, total: number): number {
	if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0) return 1;
	return Math.min(1, Math.max(0, free / total));
}

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
