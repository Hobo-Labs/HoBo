/**
 * Host memory/CPU pressure beyond MemAvailable: PSI and swap activity.
 *
 * Shared boxes lose headroom without warning; MemAvailable can look adequate
 * while the kernel is already stalling tasks. Admission and in-flight stall
 * recovery use these signals separately from per-job CI usage metrics.
 */

import { readFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { memoryAdmitHeadroom } from "@hobo/ci";
import { parseAvailableMemoryMb } from "./memory-classes.js";

export type PsiAverages = Readonly<{
	someAvg10: number;
	fullAvg10: number;
}>;

export type HostResourcePressureSample = Readonly<{
	atMs: number;
	availableMb?: number;
	memoryPsi?: PsiAverages;
	cpuPsi?: PsiAverages;
	ioPsi?: PsiAverages;
	swapUsedMb?: number;
	swapTotalMb?: number;
	loadPerCpu?: number;
}>;

export type HostPressureAdmissionThresholds = Readonly<{
	/** Block admission when memory PSI `full` avg10 is at or above this. */
	memoryPsiFullAdmit: number;
	/** Block admission when CPU PSI `full` avg10 is at or above this. */
	cpuPsiFullAdmit: number;
	/**
	 * Block admission when CPU PSI `some` avg10 is at or above this. The kernel
	 * reports system-wide CPU `full` as zero, so `some` is the only host signal.
	 */
	cpuPsiSomeAdmit: number;
	/** Block admission when swap used exceeds this share of swap total (0–1). */
	swapUsedFractionAdmit: number;
}>;

export const DEFAULT_HOST_PRESSURE_ADMISSION_THRESHOLDS = {
	memoryPsiFullAdmit: 12,
	cpuPsiFullAdmit: 45,
	cpuPsiSomeAdmit: 50,
	swapUsedFractionAdmit: 0.35,
} as const satisfies HostPressureAdmissionThresholds;

/** CPUs a Main Fabric workspace shard typically consumes on the host (observed ~430%). */
export const DEFAULT_TRUNK_JOB_CPU_REQUEST = 4;
/** Headroom kept under load when admitting another trunk job. */
export const DEFAULT_CPU_ADMISSION_VOLATILITY_CPUS = 1;
/** Time constant of the kernel's 1-minute load average. */
export const LOAD1_TIME_CONSTANT_MS = 60_000;
/** How long a started job is assumed to take to reach its resident memory. */
export const DEFAULT_MEMORY_RAMP_MS = 120_000;

function elapsedSince(startedAt: string | undefined, nowMs: number) {
	if (!startedAt) return undefined;
	const startedMs = Date.parse(startedAt);
	if (!Number.isFinite(startedMs)) return undefined;
	return Math.max(0, nowMs - startedMs);
}

/**
 * Share of a running job's steady CPU the 1-minute load average does not show
 * yet. The average is an exponential one, so a job that started `t` ago is
 * only `1 - e^(-t/60s)` visible. A job with no start time is taken as visible.
 */
export function cpuShareNotYetInLoad1(
	startedAt: string | undefined,
	nowMs: number,
): number {
	const elapsedMs = elapsedSince(startedAt, nowMs);
	if (elapsedMs === undefined) return 0;
	const share = Math.exp(-elapsedMs / LOAD1_TIME_CONSTANT_MS);
	return share < 0.05 ? 0 : share;
}

/**
 * Share of a running job's reservation MemAvailable does not show yet, falling
 * in a straight line over the ramp. A job with no start time is taken as
 * resident; a ramp of zero turns the hold off for running jobs.
 */
export function memoryShareNotYetResident(
	startedAt: string | undefined,
	nowMs: number,
	rampMs: number,
): number {
	if (!(rampMs > 0)) return 0;
	const elapsedMs = elapsedSince(startedAt, nowMs);
	if (elapsedMs === undefined) return 0;
	return Math.max(0, 1 - elapsedMs / rampMs);
}

export type TrunkCpuLeaseSignal = Readonly<{
	memoryMb: number;
	state: string;
	sandboxStage?: string;
}>;

/** Running trunk work is already in the 1m load average — do not reserve again. */
export function trunkCpuLeaseSignal(
	memoryMb: number,
	state: string,
	sandboxStage?: string,
): TrunkCpuLeaseSignal {
	if (sandboxStage === undefined) return { memoryMb, state };
	return { memoryMb, state, sandboxStage };
}

export function leaseCpuLoadAccountedInLoad1(
	lease: TrunkCpuLeaseSignal,
): boolean {
	if (lease.sandboxStage === "running") return true;
	return lease.state === "running" && lease.sandboxStage === undefined;
}

/**
 * CPU reserve for standard+ work launching on the host (container coming up).
 * Memory-only `reserved` holds (no sandbox yet) are not started work — they
 * must not each claim four CPUs while blocked on this same admission gate.
 */
function trunkSandboxNotStarted(stage: string | undefined): boolean {
	return stage === undefined || stage === "";
}

export function leasePendingTrunkCpuReservation(
	lease: TrunkCpuLeaseSignal,
	standardClassMb: number,
): boolean {
	if (lease.memoryMb < standardClassMb) return false;
	if (leaseCpuLoadAccountedInLoad1(lease)) return false;
	if (lease.state === "reserved" && trunkSandboxNotStarted(lease.sandboxStage))
		return false;
	return true;
}

export function pendingTrunkCpuReservationCpus(
	admittedLeases: readonly TrunkCpuLeaseSignal[],
	standardClassMb: number,
	cpusPerJob: number,
): number {
	let pending = 0;
	for (const lease of admittedLeases) {
		if (!leasePendingTrunkCpuReservation(lease, standardClassMb)) continue;
		pending += cpusPerJob;
	}
	return pending;
}

export type HostCpuAdmissionInput = Readonly<{
	cores: number;
	/** 1-minute load average (includes CPUs used by running containers). */
	load1: number;
	/** CPUs reserved for admitted work not yet visible in load1. */
	reservedCpus: number;
	volatilityCpus: number;
	requestCpus: number;
	/** Standard+ jobs already running (logged; load already in load1). */
	runningTrunkJobs?: number;
}>;

export function hostCpuHeadroomCpus(input: HostCpuAdmissionInput): number {
	return input.cores - input.load1 - input.reservedCpus - input.volatilityCpus;
}

export function hostCpuAdmitFits(input: HostCpuAdmissionInput): boolean {
	if (!Number.isFinite(input.cores) || input.cores < 1) return true;
	return hostCpuHeadroomCpus(input) >= input.requestCpus;
}

export type ContainerStallThresholds = Readonly<{
	memoryPsiFullStall: number;
	cpuPsiFullStall: number;
	loadPerCpuStall: number;
	swapDeltaMbStall: number;
	consecutiveSamples: number;
}>;

export const DEFAULT_CONTAINER_STALL_THRESHOLDS = {
	memoryPsiFullStall: 25,
	cpuPsiFullStall: 45,
	loadPerCpuStall: 2,
	swapDeltaMbStall: 64,
	consecutiveSamples: 3,
} as const satisfies ContainerStallThresholds;

export function parsePsiAverages(text: string): PsiAverages | undefined {
	const some = /^some avg10=([\d.]+)/mu.exec(text);
	const full = /^full avg10=([\d.]+)/mu.exec(text);
	if (!some?.[1] || !full?.[1]) return undefined;
	const someAvg10 = Number(some[1]);
	const fullAvg10 = Number(full[1]);
	if (!Number.isFinite(someAvg10) || !Number.isFinite(fullAvg10))
		return undefined;
	return { someAvg10, fullAvg10 };
}

function readPsi(resource: "memory" | "cpu" | "io"): PsiAverages | undefined {
	try {
		return parsePsiAverages(readFileSync(`/proc/pressure/${resource}`, "utf8"));
	} catch {
		return undefined;
	}
}

type SwapMb = Readonly<{
	swapUsedMb: number;
	swapTotalMb: number;
}>;

function parseSwapMb(meminfo: string): SwapMb | undefined {
	const total = /^SwapTotal:[ \t]+(\d+)[ \t]+kB/mu.exec(meminfo)?.[1];
	const free = /^SwapFree:[ \t]+(\d+)[ \t]+kB/mu.exec(meminfo)?.[1];
	if (!total || !free) return undefined;
	const swapTotalKb = Number(total);
	const swapFreeKb = Number(free);
	if (!Number.isSafeInteger(swapTotalKb) || !Number.isSafeInteger(swapFreeKb))
		return undefined;
	const swapTotalMb = Math.floor(swapTotalKb / 1024);
	const swapUsedMb = Math.max(0, swapTotalMb - Math.floor(swapFreeKb / 1024));
	return { swapTotalMb, swapUsedMb } satisfies SwapMb;
}

export function readHostResourcePressureSample(
	atMs: number,
	paths: Readonly<{
		meminfo?: string;
	}> = {},
): HostResourcePressureSample {
	const meminfoPath = paths.meminfo ?? "/proc/meminfo";
	let meminfo = "";
	try {
		meminfo = readFileSync(meminfoPath, "utf8");
	} catch {
		return {
			atMs,
			loadPerCpu: (loadavg()[0] ?? 0) / Math.max(1, cpus().length),
		};
	}
	const parsedAvailable = parseAvailableMemoryMb(meminfo);
	const swap = parseSwapMb(meminfo);
	const memoryPsi = readPsi("memory");
	const cpuPsi = readPsi("cpu");
	const ioPsi = readPsi("io");
	type MutableHostResourcePressureSample = {
		-readonly [Key in keyof HostResourcePressureSample]: HostResourcePressureSample[Key];
	};
	const sample: MutableHostResourcePressureSample = {
		atMs,
		loadPerCpu: (loadavg()[0] ?? 0) / Math.max(1, cpus().length),
	};
	if (parsedAvailable !== undefined) sample.availableMb = parsedAvailable;
	if (memoryPsi !== undefined) sample.memoryPsi = memoryPsi;
	if (cpuPsi !== undefined) sample.cpuPsi = cpuPsi;
	if (ioPsi !== undefined) sample.ioPsi = ioPsi;
	if (swap !== undefined) {
		sample.swapUsedMb = swap.swapUsedMb;
		sample.swapTotalMb = swap.swapTotalMb;
	}
	return sample;
}

export function hostPressureBlocksAdmission(
	sample: HostResourcePressureSample,
	thresholds: HostPressureAdmissionThresholds = DEFAULT_HOST_PRESSURE_ADMISSION_THRESHOLDS,
): boolean {
	if (
		sample.memoryPsi !== undefined &&
		sample.memoryPsi.fullAvg10 >= thresholds.memoryPsiFullAdmit
	)
		return true;
	if (
		sample.cpuPsi !== undefined &&
		(sample.cpuPsi.fullAvg10 >= thresholds.cpuPsiFullAdmit ||
			sample.cpuPsi.someAvg10 >= thresholds.cpuPsiSomeAdmit)
	)
		return true;
	if (
		sample.swapTotalMb !== undefined &&
		sample.swapTotalMb > 0 &&
		sample.swapUsedMb !== undefined &&
		sample.swapUsedMb / sample.swapTotalMb >= thresholds.swapUsedFractionAdmit
	)
		return true;
	return false;
}

export function hostMemoryAdmitRequiredMb(
	requestMb: number,
	reserveMb: number,
	volatilityMb: number,
): number {
	return requestMb + reserveMb + volatilityMb;
}

export function hostMemoryAdmitFits(
	availableMb: number | undefined,
	requestMb: number,
	reserveMb: number,
	volatilityMb: number,
	pressure?: HostResourcePressureSample,
	pressureThresholds?: HostPressureAdmissionThresholds,
	/** Memory promised to admitted jobs that MemAvailable does not show yet. */
	committedMb = 0,
): boolean {
	if (
		pressure !== undefined &&
		hostPressureBlocksAdmission(pressure, pressureThresholds)
	)
		return false;
	return memoryAdmitHeadroom(
		availableMb,
		requestMb,
		reserveMb,
		volatilityMb,
		committedMb,
	);
}

export type HostResourcePressureLogFields = Readonly<
	Record<string, string | number | boolean>
>;

export type HostResourcePressureLog = (
	event: "hobo_ci_host_resource_pressure",
	fields: HostResourcePressureLogFields,
) => void;

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

export function trunkWorkerCpuHeadroomFields(input: HostCpuAdmissionInput) {
	const fields = {
		cpuCores: input.cores,
		cpuLoad1: round3(input.load1),
		cpuReserved: round3(input.reservedCpus),
		cpuVolatility: input.volatilityCpus,
		cpuRequest: input.requestCpus,
		cpuHeadroom: round3(hostCpuHeadroomCpus(input)),
	} satisfies Readonly<Record<string, number>>;
	if (input.runningTrunkJobs !== undefined)
		Object.assign(fields, { cpuRunningTrunkJobs: input.runningTrunkJobs });
	return fields;
}

export function hostResourcePressureLogFields(
	sample: HostResourcePressureSample,
) {
	const fields = {
		atMs: sample.atMs,
		loadPerCpu: round3(sample.loadPerCpu ?? -1),
	} satisfies Record<string, string | number | boolean>;
	if (sample.availableMb !== undefined)
		Object.assign(fields, { availableMb: sample.availableMb });
	if (sample.memoryPsi !== undefined) {
		Object.assign(fields, {
			memoryPsiSomeAvg10: round3(sample.memoryPsi.someAvg10),
			memoryPsiFullAvg10: round3(sample.memoryPsi.fullAvg10),
		});
	}
	if (sample.cpuPsi !== undefined) {
		Object.assign(fields, {
			cpuPsiSomeAvg10: round3(sample.cpuPsi.someAvg10),
			cpuPsiFullAvg10: round3(sample.cpuPsi.fullAvg10),
		});
	}
	if (sample.ioPsi !== undefined) {
		Object.assign(fields, {
			ioPsiSomeAvg10: round3(sample.ioPsi.someAvg10),
			ioPsiFullAvg10: round3(sample.ioPsi.fullAvg10),
		});
	}
	if (sample.swapUsedMb !== undefined)
		Object.assign(fields, { swapUsedMb: sample.swapUsedMb });
	if (sample.swapTotalMb !== undefined)
		Object.assign(fields, { swapTotalMb: sample.swapTotalMb });
	return fields satisfies HostResourcePressureLogFields;
}

export type ContainerStallReason =
	| "memory-psi"
	| "cpu-psi-load"
	| "swap-activity";

export type ContainerStallSignal = Readonly<{
	reason: ContainerStallReason;
	sample: HostResourcePressureSample;
	consecutive: number;
}>;

export function createContainerStallGuard(options: {
	thresholds?: ContainerStallThresholds;
	now?: () => number;
	read?: () => HostResourcePressureSample;
}) {
	const thresholds = options.thresholds ?? DEFAULT_CONTAINER_STALL_THRESHOLDS;
	const now = options.now ?? Date.now;
	const read =
		options.read ??
		(() => readHostResourcePressureSample(now(), { meminfo: "/proc/meminfo" }));
	const consecutive = new Map<string, number>();
	let lastSwapUsedMb: number | undefined;
	let lastSampleAtMs: number | undefined;

	function swapDeltaMb(sample: HostResourcePressureSample): number {
		if (
			sample.swapUsedMb === undefined ||
			lastSwapUsedMb === undefined ||
			lastSampleAtMs === undefined
		)
			return 0;
		return Math.max(0, sample.swapUsedMb - lastSwapUsedMb);
	}

	function stallReason(
		sample: HostResourcePressureSample,
		deltaMb: number,
	): ContainerStallReason | undefined {
		if (
			sample.memoryPsi !== undefined &&
			sample.memoryPsi.fullAvg10 >= thresholds.memoryPsiFullStall
		)
			return "memory-psi";
		if (
			sample.cpuPsi !== undefined &&
			sample.cpuPsi.fullAvg10 >= thresholds.cpuPsiFullStall &&
			(sample.loadPerCpu ?? 0) >= thresholds.loadPerCpuStall
		)
			return "cpu-psi-load";
		if (deltaMb >= thresholds.swapDeltaMbStall) return "swap-activity";
		return undefined;
	}

	return {
		evaluate(leaseId: string): ContainerStallSignal | undefined {
			const sample = read();
			const deltaMb = swapDeltaMb(sample);
			lastSwapUsedMb = sample.swapUsedMb;
			lastSampleAtMs = sample.atMs;
			const reason = stallReason(sample, deltaMb);
			if (!reason) {
				consecutive.delete(leaseId);
				return undefined;
			}
			const next = (consecutive.get(leaseId) ?? 0) + 1;
			consecutive.set(leaseId, next);
			if (next < thresholds.consecutiveSamples) return undefined;
			consecutive.delete(leaseId);
			return { reason, sample, consecutive: next };
		},
		clear(leaseId: string) {
			consecutive.delete(leaseId);
		},
	};
}

export type ContainerStallGuard = ReturnType<typeof createContainerStallGuard>;
