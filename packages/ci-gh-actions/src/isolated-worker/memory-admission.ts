import type { Lease } from "@hobo/ci";
import {
	leaseOccupiesWorkerMemory,
	leaseOccupiesWorkerResources,
} from "../lease-resource-occupancy.js";
import {
	DEFAULT_CPU_ADMISSION_VOLATILITY_CPUS,
	DEFAULT_TRUNK_JOB_CPU_REQUEST,
	type HostResourcePressureSample,
	hostCpuAdmitFits,
	hostMemoryAdmitFits,
	hostMemoryAdmitRequiredMb,
	hostPressureBlocksAdmission,
	leaseCpuLoadAccountedInLoad1,
	pendingTrunkCpuReservationCpus,
	trunkCpuLeaseSignal,
	trunkWorkerCpuHeadroomFields,
} from "./host-resource-pressure.js";
import type {
	WorkerMemoryClassName,
	WorkerMemoryConfig,
} from "./memory-classes.js";
import { learnedReservationMb } from "./memory-peaks.js";

export type MemoryLease = Readonly<{
	id: string;
	memoryMb: number;
	memoryClass: string;
	state: string;
	sandboxName?: string;
	sandboxSessionId?: string;
	sandboxStage?: string;
	provider?: string;
	pipelineId?: string;
}>;
export type MemoryAdmissionLog = (
	event: "hobo_ci_memory_admission_wait" | "hobo_ci_memory_admitted",
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;
type MemoryAdmissionWaitFields = {
	jobId: number;
	memoryClass: WorkerMemoryClassName;
	requestMb: number;
	classMb: number;
	learned: boolean;
	inUseMb: number;
	budgetMb: number;
	availableMb?: number;
	waitedMs: number;
	reason:
		| "trunk-pr-cap"
		| "memory-budget"
		| "memory-headroom"
		| "host-available"
		| "host-pressure"
		| "cpu-contention";
	requiredMb?: number;
	activeGeneral: number;
	prCapWithTrunk: number;
};
export type MemoryAdmissionRejectReason =
	| "trunk-pr-cap"
	| "memory-budget"
	| "memory-headroom"
	| "host-available"
	| "host-pressure"
	| "cpu-contention";

export type MemoryAdmissionDecision = Readonly<{
	admitted: boolean;
	blockRank: boolean;
	reason?: MemoryAdmissionRejectReason;
}>;
export type MemoryAdmissionRequest = Readonly<{
	jobId: number;
	memoryClass: WorkerMemoryClassName;
	memoryMb: number;
	rank: number;
	activeLeases: readonly MemoryLease[];
	generalLeaseIds: ReadonlySet<string>;
	/** Rank-0 active leases; label-based general IDs remain a fallback for direct callers. */
	trunkLeaseIds?: ReadonlySet<string>;
}>;

export function createWorkerMemoryAdmission(
	config: WorkerMemoryConfig,
	options: {
		now?: () => number;
		log?: MemoryAdmissionLog;
		prCapWithTrunk?: number;
		availableMemoryMb?: () => number | undefined;
		volatilityMb?: number;
		hostPressure?: () => HostResourcePressureSample | undefined;
		hostCores?: () => number;
		trunkJobCpuRequest?: number;
		cpuVolatilityCpus?: number;
	} = {},
) {
	const now = options.now ?? Date.now;
	const prCapWithTrunk = options.prCapWithTrunk ?? 1;
	if (
		!Number.isInteger(prCapWithTrunk) ||
		prCapWithTrunk < 0 ||
		prCapWithTrunk > 8
	)
		throw new Error("invalid PR cap with trunk");
	const volatilityMb = options.volatilityMb ?? 0;
	if (
		!Number.isFinite(volatilityMb) ||
		volatilityMb < 0 ||
		!Number.isInteger(volatilityMb)
	)
		throw new Error("invalid memory admission volatilityMb");
	const trunkJobCpuRequest =
		options.trunkJobCpuRequest ?? DEFAULT_TRUNK_JOB_CPU_REQUEST;
	if (
		!Number.isInteger(trunkJobCpuRequest) ||
		trunkJobCpuRequest < 1 ||
		trunkJobCpuRequest > 32
	)
		throw new Error("invalid trunk job cpu request");
	const cpuVolatilityCpus =
		options.cpuVolatilityCpus ?? DEFAULT_CPU_ADMISSION_VOLATILITY_CPUS;
	if (
		!Number.isFinite(cpuVolatilityCpus) ||
		cpuVolatilityCpus < 0 ||
		!Number.isInteger(cpuVolatilityCpus)
	)
		throw new Error("invalid cpu admission volatility");
	const hostCores = options.hostCores ?? (() => 1);
	const waiting = new Map<number, { sinceMs: number; signature: string }>();
	let warmMb = 0;

	function leaseMemoryMb(lease: MemoryLease): number {
		return Number.isInteger(lease.memoryMb) && lease.memoryMb >= 512
			? lease.memoryMb
			: config.classes.heavy;
	}

	function trunkReservationMb(): number {
		if (!config.learn || config.trunkReservationMb === 0)
			return config.trunkReservationMb;
		return learnedReservationMb(
			config.memoryPeaks?.["Main full gate"],
			config.classes.heavy,
			config.unmeasured.heavy,
			now(),
		);
	}

	function launchingLeases(activeLeases: readonly MemoryLease[]) {
		return activeLeases.filter((lease) => {
			// SAFETY: MemoryLease carries the occupancy fields `leaseOccupiesWorkerResources` reads.
			const full = lease as Lease;
			return leaseOccupiesWorkerResources(full);
		});
	}

	function runningOsCommittedMb(activeLeases: readonly MemoryLease[]): number {
		return launchingLeases(activeLeases).reduce(
			(total, lease) => total + leaseMemoryMb(lease),
			0,
		);
	}

	function admittedMemoryLeases(activeLeases: readonly MemoryLease[]) {
		return activeLeases.filter((lease) => {
			// SAFETY: MemoryLease carries the occupancy fields worker memory reads.
			const full = lease as Lease;
			return leaseOccupiesWorkerMemory(full);
		});
	}

	function unlaunchedReservedLeases(activeLeases: readonly MemoryLease[]) {
		return activeLeases.filter((lease) => {
			// SAFETY: MemoryLease carries reserved/sandbox fields for unlaunched detection.
			const full = lease as Lease;
			return (
				full.state === "reserved" && !full.sandboxName && !full.sandboxSessionId
			);
		});
	}

	function unlaunchedGeneralReservedMb(
		activeLeases: readonly MemoryLease[],
		generalLeaseIds: ReadonlySet<string>,
	): number {
		return unlaunchedReservedLeases(activeLeases)
			.filter((lease) => generalLeaseIds.has(lease.id))
			.reduce((total, lease) => total + leaseMemoryMb(lease), 0);
	}

	function inUseMb(
		activeLeases: readonly MemoryLease[],
		generalLeaseIds: ReadonlySet<string>,
		includeTrunkReservation = true,
	): number {
		const launching = launchingLeases(activeLeases);
		const reserved = unlaunchedReservedLeases(activeLeases);
		const leasesMb = launching.reduce(
			(total, lease) => total + leaseMemoryMb(lease),
			0,
		);
		const reservedMb = reserved.reduce(
			(total, lease) => total + leaseMemoryMb(lease),
			0,
		);
		const trunkMb = launching
			.filter((lease) => !generalLeaseIds.has(lease.id))
			.reduce((total, lease) => total + leaseMemoryMb(lease), 0);
		return (
			leasesMb +
			reservedMb +
			warmMb +
			(includeTrunkReservation
				? Math.max(0, trunkReservationMb() - trunkMb)
				: 0)
		);
	}

	function admit(request: MemoryAdmissionRequest): MemoryAdmissionDecision {
		const admittedLeases = admittedMemoryLeases(request.activeLeases);
		const inUse = inUseMb(
			request.activeLeases,
			request.generalLeaseIds,
			request.rank !== 0,
		);
		const trunkLeaseIds =
			request.trunkLeaseIds ??
			new Set(
				admittedLeases
					.filter((lease) => !request.generalLeaseIds.has(lease.id))
					.map((lease) => lease.id),
			);
		const trunkActive = admittedLeases.some((lease) =>
			trunkLeaseIds.has(lease.id),
		);
		const activeNonTrunk = admittedLeases.filter(
			(lease) => !trunkLeaseIds.has(lease.id),
		).length;
		const capBlocked =
			request.rank !== 0 && trunkActive && activeNonTrunk >= prCapWithTrunk;
		const classMb = config.classes[request.memoryClass];
		const learned = config.learn && request.memoryMb < classMb;
		const availableMb = options.availableMemoryMb?.();
		const pressure = options.hostPressure?.();
		const pressureBlocked =
			pressure !== undefined && hostPressureBlocksAdmission(pressure);
		const trunkCpuSignals = admittedLeases.map((lease) =>
			trunkCpuLeaseSignal(
				leaseMemoryMb(lease),
				lease.state,
				lease.sandboxStage,
			),
		);
		const standardTrunkLeases = trunkCpuSignals.filter(
			(lease) => lease.memoryMb >= config.classes.standard,
		);
		const runningTrunkJobs = standardTrunkLeases.filter((lease) =>
			leaseCpuLoadAccountedInLoad1(lease),
		).length;
		const cores = hostCores();
		const load1 =
			pressure?.loadPerCpu !== undefined && Number.isFinite(pressure.loadPerCpu)
				? pressure.loadPerCpu * cores
				: 0;
		const cpuInput = {
			cores,
			load1,
			reservedCpus: pendingTrunkCpuReservationCpus(
				trunkCpuSignals,
				config.classes.standard,
				trunkJobCpuRequest,
			),
			volatilityCpus: cpuVolatilityCpus,
			requestCpus: trunkJobCpuRequest,
			runningTrunkJobs,
		};
		const trunkCpuBlocked =
			cores >= trunkJobCpuRequest &&
			request.memoryMb >= config.classes.standard &&
			!hostCpuAdmitFits(cpuInput);
		const trunkBudgetBiasMb =
			request.rank === 0
				? unlaunchedGeneralReservedMb(
						request.activeLeases,
						request.generalLeaseIds,
					)
				: 0;
		const budgetFits =
			inUse - trunkBudgetBiasMb + request.memoryMb <= config.budgetMb;
		const hostFits = hostMemoryAdmitFits(
			availableMb,
			request.memoryMb,
			config.reserveMb,
			volatilityMb,
			pressure,
			undefined,
			runningOsCommittedMb(request.activeLeases),
		);
		const admitted =
			!capBlocked &&
			budgetFits &&
			hostFits &&
			!pressureBlocked &&
			!trunkCpuBlocked;
		if (admitted) {
			const previous = waiting.get(request.jobId);
			waiting.delete(request.jobId);
			options.log?.("hobo_ci_memory_admitted", {
				jobId: request.jobId,
				memoryClass: request.memoryClass,
				requestMb: request.memoryMb,
				classMb,
				learned,
				inUseMb: inUse,
				budgetMb: config.budgetMb,
				waitedMs: previous ? now() - previous.sinceMs : 0,
			});
			return { admitted: true, blockRank: false };
		}
		let state = waiting.get(request.jobId);
		if (!state) {
			if (waiting.size >= 1_000) {
				const oldest = waiting.keys().next();
				if (!oldest.done) waiting.delete(oldest.value);
			}
			state = { sinceMs: now(), signature: "" };
			waiting.set(request.jobId, state);
		}
		const waitedMs = now() - state.sinceMs;
		const blockRank =
			request.rank === 0
				? request.memoryMb <= config.budgetMb
				: waitedMs > config.holMs;
		const reason = capBlocked
			? "trunk-pr-cap"
			: trunkCpuBlocked
				? "cpu-contention"
				: pressureBlocked
					? "host-pressure"
					: !budgetFits
						? "memory-budget"
						: !hostFits
							? "memory-headroom"
							: "host-available";
		const requiredMb = hostMemoryAdmitRequiredMb(
			request.memoryMb,
			config.reserveMb,
			volatilityMb,
		);
		const availabilitySignature =
			(reason === "host-available" || reason === "memory-headroom") &&
			availableMb !== undefined
				? `:${Math.floor(availableMb / 512) * 512}:${requiredMb}`
				: "";
		const signature = `${reason}:${request.memoryClass}:${request.memoryMb}:${inUse}:${config.budgetMb}:${activeNonTrunk}:${blockRank}${availabilitySignature}`;
		if (signature !== state.signature) {
			state.signature = signature;
			const fields: MemoryAdmissionWaitFields = {
				jobId: request.jobId,
				memoryClass: request.memoryClass,
				requestMb: request.memoryMb,
				classMb,
				learned,
				inUseMb: inUse,
				budgetMb: config.budgetMb,
				waitedMs,
				reason,
				activeGeneral: activeNonTrunk,
				prCapWithTrunk,
			};
			if (availableMb !== undefined) fields.availableMb = availableMb;
			if (reason === "memory-headroom") fields.requiredMb = requiredMb;
			if (reason === "cpu-contention") {
				Object.assign(fields, trunkWorkerCpuHeadroomFields(cpuInput));
			}
			options.log?.("hobo_ci_memory_admission_wait", fields);
		}
		return { admitted: false, blockRank, reason };
	}

	function releaseWarm(requestMb: number) {
		if (requestMb > warmMb) throw new Error("warm memory accounting mismatch");
		warmMb -= requestMb;
	}

	return {
		config,
		admit,
		reserveWarm(
			activeLeases: readonly MemoryLease[],
			requestMb: number,
			generalLeaseIds: ReadonlySet<string>,
		) {
			const availableMb = options.availableMemoryMb?.();
			const pressure = options.hostPressure?.();
			const budgetFits =
				inUseMb(activeLeases, generalLeaseIds) + requestMb <= config.budgetMb;
			const hostFits = hostMemoryAdmitFits(
				availableMb,
				requestMb,
				config.reserveMb,
				volatilityMb,
				pressure,
			);
			if (
				!budgetFits ||
				!hostFits ||
				(pressure !== undefined && hostPressureBlocksAdmission(pressure))
			)
				return false;
			warmMb += requestMb;
			return true;
		},
		releaseWarm,
		consumeWarm: releaseWarm,
	};
}

export type WorkerMemoryAdmission = ReturnType<
	typeof createWorkerMemoryAdmission
>;
