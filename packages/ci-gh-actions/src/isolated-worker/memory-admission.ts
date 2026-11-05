import type {
	WorkerMemoryClassName,
	WorkerMemoryConfig,
} from "./memory-classes.js";

export type MemoryLease = Readonly<{
	id: string;
	memoryMb: number;
	memoryClass: string;
	state: string;
	sandboxName?: string;
}>;
export type MemoryAdmissionLog = (
	event: "hobo_ci_memory_admission_wait" | "hobo_ci_memory_admitted",
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;
export type MemoryAdmissionDecision = Readonly<{
	admitted: boolean;
	blockRank: boolean;
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
	const waiting = new Map<number, { sinceMs: number; signature: string }>();
	let warmMb = 0;

	function leaseMemoryMb(lease: MemoryLease): number {
		return Number.isInteger(lease.memoryMb) && lease.memoryMb >= 512
			? lease.memoryMb
			: config.classes.heavy;
	}

	function launchingLeases(activeLeases: readonly MemoryLease[]) {
		return activeLeases.filter(
			(lease) => lease.state !== "reserved" || (lease.sandboxName ?? "") !== "",
		);
	}

	function inUseMb(
		activeLeases: readonly MemoryLease[],
		generalLeaseIds: ReadonlySet<string>,
		includeTrunkReservation = true,
	): number {
		const launching = launchingLeases(activeLeases);
		const leasesMb = launching.reduce(
			(total, lease) => total + leaseMemoryMb(lease),
			0,
		);
		const trunkMb = launching
			.filter((lease) => !generalLeaseIds.has(lease.id))
			.reduce((total, lease) => total + leaseMemoryMb(lease), 0);
		return (
			leasesMb +
			warmMb +
			(includeTrunkReservation
				? Math.max(0, config.trunkReservationMb - trunkMb)
				: 0)
		);
	}

	function admit(request: MemoryAdmissionRequest): MemoryAdmissionDecision {
		const activeLeases = launchingLeases(request.activeLeases);
		const inUse = inUseMb(
			activeLeases,
			request.generalLeaseIds,
			request.rank !== 0,
		);
		const trunkLeaseIds =
			request.trunkLeaseIds ??
			new Set(
				activeLeases
					.filter((lease) => !request.generalLeaseIds.has(lease.id))
					.map((lease) => lease.id),
			);
		const trunkActive = activeLeases.some((lease) =>
			trunkLeaseIds.has(lease.id),
		);
		const activeNonTrunk = activeLeases.filter(
			(lease) => !trunkLeaseIds.has(lease.id),
		).length;
		const capBlocked =
			request.rank !== 0 && trunkActive && activeNonTrunk >= prCapWithTrunk;
		const admitted = !capBlocked && inUse + request.memoryMb <= config.budgetMb;
		if (admitted) {
			const previous = waiting.get(request.jobId);
			waiting.delete(request.jobId);
			options.log?.("hobo_ci_memory_admitted", {
				jobId: request.jobId,
				memoryClass: request.memoryClass,
				requestMb: request.memoryMb,
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
		const reason = capBlocked ? "trunk-pr-cap" : "memory-budget";
		const signature = `${reason}:${request.memoryClass}:${request.memoryMb}:${inUse}:${config.budgetMb}:${activeNonTrunk}:${blockRank}`;
		if (signature !== state.signature) {
			state.signature = signature;
			options.log?.("hobo_ci_memory_admission_wait", {
				jobId: request.jobId,
				memoryClass: request.memoryClass,
				requestMb: request.memoryMb,
				inUseMb: inUse,
				budgetMb: config.budgetMb,
				waitedMs,
				reason,
				activeGeneral: activeNonTrunk,
				prCapWithTrunk,
			});
		}
		return { admitted: false, blockRank };
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
			if (inUseMb(activeLeases, generalLeaseIds) + requestMb > config.budgetMb)
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
