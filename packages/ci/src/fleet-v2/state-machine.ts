import { FleetRejectionCode } from "../_generated/fleet_v2_pb.js";

export class FleetRejection extends Error {
	readonly code: FleetRejectionCode;

	constructor(code: FleetRejectionCode, message: string) {
		super(message);
		this.name = "FleetRejection";
		this.code = code;
	}
}

export function rejectFleet(code: FleetRejectionCode, message: string): never {
	throw new FleetRejection(code, message);
}

export const CI_DEMAND_STATES = [
	"observed",
	"eligible",
	"satisfied",
	"expired-before-effect",
] as const;
export const RUNNER_SLOT_STATES = [
	"reserved",
	"provisioning",
	"registered",
	"bound",
	"draining",
	"released",
	"uncertain",
] as const;
export const EXECUTION_CLAIM_STATES = [
	"start-authorized",
	"running",
	"completed",
	"failed",
	"cancelled",
	"uncertain",
] as const;
export const EFFECT_STATES = [
	"planned",
	"dispatching",
	"confirmed",
	"uncertain",
] as const;
export const CAPACITY_GROUP_STATES = [
	"active",
	"paused",
	"draining",
	"revoked",
	"quarantined",
] as const;
export const WORKER_DELIVERY_STATES = [
	"claimed",
	"acked",
	"expired",
	"superseded",
] as const;
export const OUTBOX_STATES = [
	"pending",
	"claimed",
	"done",
	"uncertain",
] as const;

export type CiDemandState = (typeof CI_DEMAND_STATES)[number];
export type RunnerSlotState = (typeof RUNNER_SLOT_STATES)[number];
export type ExecutionClaimState = (typeof EXECUTION_CLAIM_STATES)[number];
export type EffectState = (typeof EFFECT_STATES)[number];
export type CapacityGroupState = (typeof CAPACITY_GROUP_STATES)[number];
export type WorkerDeliveryState = (typeof WORKER_DELIVERY_STATES)[number];
export type OutboxState = (typeof OUTBOX_STATES)[number];

const demandTransitions = {
	observed: ["eligible", "expired-before-effect"],
	eligible: ["satisfied", "expired-before-effect"],
	satisfied: [],
	"expired-before-effect": [],
} as const satisfies Record<CiDemandState, readonly CiDemandState[]>;
const slotTransitions = {
	reserved: ["provisioning", "released", "uncertain"],
	provisioning: ["registered", "released", "uncertain"],
	registered: ["bound", "draining", "uncertain"],
	bound: ["draining", "uncertain"],
	draining: ["released", "uncertain"],
	released: [],
	uncertain: [],
} as const satisfies Record<RunnerSlotState, readonly RunnerSlotState[]>;
const claimTransitions = {
	"start-authorized": [
		"running",
		"completed",
		"failed",
		"cancelled",
		"uncertain",
	],
	running: ["completed", "failed", "cancelled", "uncertain"],
	completed: [],
	failed: [],
	cancelled: [],
	uncertain: ["completed", "failed", "cancelled"],
} as const satisfies Record<
	ExecutionClaimState,
	readonly ExecutionClaimState[]
>;
const effectTransitions = {
	planned: ["dispatching", "uncertain"],
	dispatching: ["planned", "confirmed", "uncertain"],
	confirmed: [],
	uncertain: [],
} as const satisfies Record<EffectState, readonly EffectState[]>;
const capacityTransitions = {
	active: ["paused", "draining", "revoked", "quarantined"],
	paused: ["active", "draining", "revoked", "quarantined"],
	draining: ["active", "revoked", "quarantined"],
	revoked: [],
	quarantined: ["active", "revoked"],
} as const satisfies Record<CapacityGroupState, readonly CapacityGroupState[]>;

function transition<State extends string>(
	from: State,
	to: State,
	allowed: readonly State[],
	kind: string,
): State {
	if (from === to) return from;
	if (!allowed.includes(to))
		rejectFleet(
			FleetRejectionCode.INVALID_TRANSITION,
			`invalid ${kind} transition ${from} -> ${to}`,
		);
	return to;
}

export function transitionCiDemand(
	from: CiDemandState,
	to: CiDemandState,
): CiDemandState {
	return transition(from, to, demandTransitions[from], "demand");
}

export function transitionRunnerSlot(
	from: RunnerSlotState,
	to: RunnerSlotState,
): RunnerSlotState {
	return transition(from, to, slotTransitions[from], "runner slot");
}

export function transitionExecutionClaim(
	from: ExecutionClaimState,
	to: ExecutionClaimState,
): ExecutionClaimState {
	return transition(from, to, claimTransitions[from], "execution claim");
}

export function transitionEffect(
	from: EffectState,
	to: EffectState,
): EffectState {
	return transition(from, to, effectTransitions[from], "effect");
}

export function transitionCapacityGroup(
	from: CapacityGroupState,
	to: CapacityGroupState,
): CapacityGroupState {
	return transition(from, to, capacityTransitions[from], "capacity group");
}
