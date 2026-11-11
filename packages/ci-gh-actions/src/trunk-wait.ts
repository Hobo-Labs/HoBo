import {
	type FleetCapacityWitness,
	type FleetWitnessFields,
	fleetWitnessFields,
} from "./fleet-absorb.js";

export type TrunkWaitReason =
	| "lease-capacity"
	| "storage"
	| "headroom"
	| "fleet-capacity"
	| "host-available"
	| "memory-budget"
	| "trunk-pr-cap"
	| "host-pressure";

export type TrunkWaitState = Readonly<{
	sinceMs: number;
	logged: boolean;
	reason: TrunkWaitReason;
}>;

export type TrunkWaitCache = Map<string, TrunkWaitState>;

/** Default wait before admission-blocked main trunk work is offered to fleet. */
// public-contract: bounds box memory hold without lowering standard class sizes.
export const DEFAULT_TRUNK_HEADROOM_FLEET_DEFER_MS = 45_000;

export function trunkWaitKey(
	job: Readonly<{ repository: string; id: number; runAttempt: number }>,
): string {
	return `${job.repository}:${job.id}:${job.runAttempt}`;
}

export function trunkWaitFleetDeferEligible(
	wait: TrunkWaitState | undefined,
	deferMs: number,
	nowMs: number,
): boolean {
	if (!wait) return false;
	if (wait.reason === "fleet-capacity") return false;
	return nowMs - wait.sinceMs >= deferMs;
}

export type TrunkFleetDeferDecision = Readonly<{
	action: "defer" | "hold";
	waitReason?: TrunkWaitReason;
	waitedMs: number;
	holdReason?: string;
}> &
	FleetWitnessFields;

export function evaluateMainTrunkFleetDefer(
	input: Readonly<{
		jobName: string | undefined;
		isMainTrunkJob: boolean;
		priorWait: TrunkWaitState | undefined;
		deferMs: number;
		nowMs: number;
		trunkSlots: number | undefined;
		localTrunkReserved: number;
		fleetWitness: FleetCapacityWitness | undefined;
	}>,
): TrunkFleetDeferDecision {
	const fields = fleetWitnessFields(input.fleetWitness);
	const waitedMs = input.priorWait
		? Math.max(0, input.nowMs - input.priorWait.sinceMs)
		: 0;
	const waitReason = input.priorWait?.reason;
	const waitReady = trunkWaitFleetDeferEligible(
		input.priorWait,
		input.deferMs,
		input.nowMs,
	);
	const slotsFull =
		input.trunkSlots !== undefined &&
		input.trunkSlots > 0 &&
		input.localTrunkReserved >= input.trunkSlots;
	const base = { waitedMs, ...fields };
	if (waitReason !== undefined) Object.assign(base, { waitReason });
	if (!input.isMainTrunkJob) {
		return { action: "hold", holdReason: "not-main-trunk", ...base };
	}
	if (fields.peerAbsorbSlots <= 0) {
		return { action: "hold", holdReason: "no-peer-capacity", ...base };
	}
	if (slotsFull || waitReady) {
		return { action: "defer", ...base };
	}
	const holdReason = input.priorWait
		? "wait-too-short"
		: slotsFull
			? "slots-full-pending"
			: "no-wait";
	return { action: "hold", holdReason, ...base };
}
