import { mainWorkspaceShardIndex } from "./admission-order.js";
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
	| "host-pressure"
	| "cpu-contention";

export type TrunkWaitState = Readonly<{
	sinceMs: number;
	logged: boolean;
	reason: TrunkWaitReason;
}>;

export type TrunkWaitCache = Map<string, TrunkWaitState>;

/** Default wait before admission-blocked main trunk work is offered to fleet. */
// public-contract: bounds box memory hold without lowering standard class sizes.
export const DEFAULT_TRUNK_HEADROOM_FLEET_DEFER_MS = 45_000;

/** Shorter cooperative window when mesh/ARC already report absorb slots (finding 119). */
export const PEER_PRESENT_TRUNK_HEADROOM_FLEET_DEFER_MS = 5_000;

export function effectiveTrunkFleetDeferMs(
	baseDeferMs: number,
	peerAbsorbSlots: number,
): number {
	if (peerAbsorbSlots <= 0) return baseDeferMs;
	return Math.min(baseDeferMs, PEER_PRESENT_TRUNK_HEADROOM_FLEET_DEFER_MS);
}

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
	deferMs?: number;
	shardIndex?: number;
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
	const effectiveDeferMs = effectiveTrunkFleetDeferMs(
		input.deferMs,
		fields.peerAbsorbSlots,
	);
	const shardIndex = mainWorkspaceShardIndex(input.jobName);
	const waitedMs = input.priorWait
		? Math.max(0, input.nowMs - input.priorWait.sinceMs)
		: 0;
	const waitReason = input.priorWait?.reason;
	const waitReady = trunkWaitFleetDeferEligible(
		input.priorWait,
		effectiveDeferMs,
		input.nowMs,
	);
	const slotsFull =
		input.trunkSlots !== undefined &&
		input.trunkSlots > 0 &&
		input.localTrunkReserved >= input.trunkSlots;
	const peerImmediate =
		fields.peerAbsorbSlots > 0 &&
		(slotsFull || input.priorWait?.reason === "cpu-contention");
	type DeferMeta = {
		waitedMs: number;
		deferMs: number;
		waitReason?: TrunkWaitReason;
		shardIndex?: number;
	} & FleetWitnessFields;
	const meta: DeferMeta = { waitedMs, deferMs: effectiveDeferMs, ...fields };
	if (waitReason !== undefined) meta.waitReason = waitReason;
	if (shardIndex !== undefined) meta.shardIndex = shardIndex;
	if (!input.isMainTrunkJob) {
		return { action: "hold", holdReason: "not-main-trunk", ...meta };
	}
	if (fields.peerAbsorbSlots <= 0) {
		return { action: "hold", holdReason: "no-peer-capacity", ...meta };
	}
	if (peerImmediate || waitReady) {
		return { action: "defer", ...meta };
	}
	const holdReason = input.priorWait
		? "wait-too-short"
		: slotsFull
			? "slots-full-pending"
			: "no-wait";
	return { action: "hold", holdReason, ...meta };
}
