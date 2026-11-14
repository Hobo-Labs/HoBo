import type {
	CapacityGroup,
	CiDemand,
	ControllerIncarnation,
	Effect,
	ExecutionClaim,
	ExecutionProfile,
	FleetEvent,
	Observation,
	OfferAdmission,
	Outbox,
	RunnerSlot,
	WorkerDelivery,
} from "../_generated/fleet_v2_pb.js";
import type {
	ParsedCapacityGroup,
	ParsedCiDemand,
	ParsedControllerIncarnation,
	ParsedEffect,
	ParsedExecutionKey,
	ParsedExecutionProfile,
	ParsedObservation,
	ParsedOfferAdmission,
	ParsedOutbox,
	ParsedRunnerSlot,
	ParsedStartBindingInput,
} from "./parse.js";
import type { ExecutionClaimState, RunnerSlotState } from "./state-machine.js";

export interface ReserveCapacityInput {
	demandKey: ParsedExecutionKey;
	slot: ParsedRunnerSlot;
	effect: ParsedEffect;
	outbox: ParsedOutbox;
	expectedCapacitySeq: number;
	expectedPolicyRevision: number;
}

export interface EffectClaimInput {
	effectId: string;
	workerId: string;
	ownerEpoch: number;
	leaseMs: number;
}

export interface EffectFenceInput {
	effectId: string;
	workerId: string;
	ownerEpoch: number;
	fence: number;
}

export interface CompleteExecutionInput {
	claimId: string;
	state: Exclude<ExecutionClaimState, "start-authorized" | "running">;
	actualStartedAt?: string;
	teardownConfirmed: boolean;
}

export interface StrictFleetStore {
	initialize(): Promise<void>;
	createIncarnation(incarnation: ParsedControllerIncarnation): Promise<void>;
	currentIncarnation(): Promise<ControllerIncarnation | undefined>;
	putExecutionProfile(profile: ParsedExecutionProfile): Promise<void>;
	putOfferAdmission(offer: ParsedOfferAdmission): Promise<void>;
	putCapacityGroup(group: ParsedCapacityGroup): Promise<CapacityGroup>;
	intake(
		demand: ParsedCiDemand,
	): Promise<{ demand: CiDemand; duplicate: boolean }>;
	reserveCapacity(input: ReserveCapacityInput): Promise<RunnerSlot>;
	transitionRunnerSlot(
		id: string,
		expected: RunnerSlotState,
		next: RunnerSlotState,
		externalRunnerId?: string,
	): Promise<RunnerSlot>;
	claimEffect(input: EffectClaimInput): Promise<WorkerDelivery>;
	renewEffectDelivery(
		input: EffectFenceInput & { leaseMs: number },
	): Promise<WorkerDelivery>;
	markEffectDispatching(input: EffectFenceInput): Promise<Effect>;
	acknowledgeEffect(
		input: EffectFenceInput & {
			outcome: "confirmed" | "uncertain" | "pre-mutation-refusal";
		},
	): Promise<Effect>;
	bindStart(
		input: ParsedStartBindingInput,
	): Promise<{ claim: ExecutionClaim; idempotent: boolean }>;
	completeExecution(input: CompleteExecutionInput): Promise<{
		claim: ExecutionClaim;
		settled: boolean;
		capacityReleased: boolean;
	}>;
	observe(observation: ParsedObservation): Promise<void>;
	demand(key: ParsedExecutionKey): Promise<CiDemand | undefined>;
	runnerSlot(id: string): Promise<RunnerSlot | undefined>;
	executionClaim(key: ParsedExecutionKey): Promise<ExecutionClaim | undefined>;
	executionClaimById(id: string): Promise<ExecutionClaim | undefined>;
	capacityGroup(id: string): Promise<CapacityGroup | undefined>;
	effect(id: string): Promise<Effect | undefined>;
	outbox(effectId: string): Promise<Outbox | undefined>;
	deliveries(effectId: string): Promise<WorkerDelivery[]>;
	observationSequence(workerId: string): Promise<number>;
	events(): Promise<FleetEvent[]>;
}

export type { ExecutionProfile, Observation, OfferAdmission };
