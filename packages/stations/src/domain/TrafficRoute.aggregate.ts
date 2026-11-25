import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
	CloudBackendTarget,
	CutoverPhase,
	CutoverRefusalReason,
	decodeEpochMs,
	decodeNonNegativeCount,
	EpochMs,
	NonEmptyReason,
	NonNegativeCount,
	RampWeightPercent,
	LoweredTtlEvidence,
	StabilityPolicy,
	TrafficRouteId,
	TtlSeconds,
} from "./ids.js";

export class CutoverCooldownActive extends Domain.Rejection(
	"CutoverCooldownActive",
	{
		nextAllowedAtMs: EpochMs,
		nowMs: EpochMs,
	},
) {}

export class CutoverFlipLimitExceeded extends Domain.Rejection(
	"CutoverFlipLimitExceeded",
	{
		swapsInWindow: NonNegativeCount,
		maxSwapsPerWindow: StabilityPolicy.fields.maxSwapsPerWindow,
	},
) {}

export class CutoverPreconditionRefused extends Domain.Rejection(
	"CutoverPreconditionRefused",
	{
		reason: CutoverRefusalReason,
	},
) {}

export class CutoverNotInProgress extends Domain.Rejection(
	"CutoverNotInProgress",
	{
		phase: CutoverPhase,
	},
) {}

export class TrafficIncumbentRegistered extends Domain.Event(
	"TrafficIncumbentRegistered",
	{
		incumbent: CloudBackendTarget,
		ttlSeconds: TtlSeconds,
		policy: StabilityPolicy,
	},
) {}

export class BudgetMigrationProposed extends Domain.Event(
	"BudgetMigrationProposed",
	{
		from: CloudBackendTarget,
		to: CloudBackendTarget,
		reason: NonEmptyReason,
		proposedAtMs: EpochMs,
		previousTtlSeconds: TtlSeconds,
	},
) {}

export class CutoverTtlLowered extends Domain.Event("CutoverTtlLowered", {
	ttlSeconds: TtlSeconds,
}) {}

export class CutoverRampAdvanced extends Domain.Event("CutoverRampAdvanced", {
	targetWeightPercent: RampWeightPercent,
	to: CloudBackendTarget,
}) {}

export class CutoverCompleted extends Domain.Event("CutoverCompleted", {
	incumbent: CloudBackendTarget,
	completedAtMs: EpochMs,
	swapsInWindow: NonNegativeCount,
}) {}

export class CutoverRolledBack extends Domain.Event("CutoverRolledBack", {
	restored: CloudBackendTarget,
	reason: NonEmptyReason,
	rolledBackAtMs: EpochMs,
	restoredTtlSeconds: TtlSeconds,
}) {}

export class CutoverReconciliationResolved extends Domain.Event(
	"CutoverReconciliationResolved",
	{
		incumbent: CloudBackendTarget,
		ttlSeconds: TtlSeconds,
		policy: StabilityPolicy,
		resolvedAtMs: EpochMs,
	},
) {}

export class CutoverReconciliationRequired extends Domain.Event(
	"CutoverReconciliationRequired",
	{
		reason: NonEmptyReason,
	},
) {}

export class RegisterTrafficIncumbent extends Domain.Command(
	"RegisterTrafficIncumbent",
	{
		target: TrafficRouteId,
		input: {
			incumbent: CloudBackendTarget,
			ttlSeconds: TtlSeconds,
			policy: StabilityPolicy,
		},
		events: [TrafficIncumbentRegistered],
		rejects: [CutoverPreconditionRefused],
	},
	{
		description:
			"Register the incumbent cloud backend target and stability policy for a traffic route.",
	},
) {}

export class ProposeBudgetMigration extends Domain.Command(
	"ProposeBudgetMigration",
	{
		target: TrafficRouteId,
		input: {
			to: CloudBackendTarget,
			reason: NonEmptyReason,
			nowMs: EpochMs,
			preconditionsMet: Schema.Boolean,
		},
		events: [BudgetMigrationProposed],
		rejects: [
			CutoverPreconditionRefused,
			CutoverCooldownActive,
			CutoverFlipLimitExceeded,
		],
	},
	{
		description:
			"Propose a budget-driven progressive migration between distinct cloud backend targets.",
	},
) {}

export class RecordTtlLowered extends Domain.Command(
	"RecordTtlLowered",
	{
		target: TrafficRouteId,
		input: {
			evidence: LoweredTtlEvidence,
		},
		events: [CutoverTtlLowered],
		rejects: [CutoverNotInProgress, CutoverPreconditionRefused],
	},
	{
		description:
			"Record that DNS TTL has been lowered prior to progressive traffic ramp.",
	},
) {}

export class RecordRampStep extends Domain.Command(
	"RecordRampStep",
	{
		target: TrafficRouteId,
		input: {
			targetWeightPercent: RampWeightPercent,
		},
		events: [CutoverRampAdvanced],
		rejects: [CutoverNotInProgress, CutoverPreconditionRefused],
	},
	{
		description: "Record an observed healthy traffic weight ramp step.",
	},
) {}

export class CompleteTrafficCutover extends Domain.Command(
	"CompleteTrafficCutover",
	{
		target: TrafficRouteId,
		input: {
			completedAtMs: EpochMs,
		},
		events: [CutoverCompleted],
		rejects: [CutoverNotInProgress, CutoverPreconditionRefused],
	},
	{
		description:
			"Complete progressive cutover and promote challenger backend to incumbent.",
	},
) {}

export class RollbackTrafficCutover extends Domain.Command(
	"RollbackTrafficCutover",
	{
		target: TrafficRouteId,
		input: {
			reason: NonEmptyReason,
			rolledBackAtMs: EpochMs,
		},
		events: [CutoverRolledBack],
		rejects: [CutoverNotInProgress],
	},
	{
		description: "Roll back progressive cutover to the incumbent backend.",
	},
) {}

export class FlagCutoverReconciliation extends Domain.Command(
	"FlagCutoverReconciliation",
	{
		target: TrafficRouteId,
		input: {
			reason: NonEmptyReason,
		},
		events: [CutoverReconciliationRequired],
		rejects: [],
	},
	{
		description:
			"Flag ambiguous noRollback provider failure for manual or automated reconciliation.",
	},
) {}

export class ResolveTrafficCutoverReconciliation extends Domain.Command(
	"ResolveTrafficCutoverReconciliation",
	{
		target: TrafficRouteId,
		input: {
			resolvedAtMs: EpochMs,
		},
		events: [CutoverReconciliationResolved],
		rejects: [CutoverPreconditionRefused],
	},
	{
		description:
			"Clear reconciliation-required state after operator confirms incumbent truth.",
	},
) {}

export const UnregisteredRouteState = Schema.TaggedStruct("Unregistered", {});

export const SteadyRouteState = Schema.TaggedStruct("Steady", {
	incumbent: CloudBackendTarget,
	policy: StabilityPolicy,
	ttlSeconds: TtlSeconds,
	swapsInWindow: NonNegativeCount,
	flipWindowStartMs: Schema.NullOr(EpochMs),
	lastCompletedAtMs: Schema.NullOr(EpochMs),
});

export const TtlLoweringRouteState = Schema.TaggedStruct("TtlLowering", {
	incumbent: CloudBackendTarget,
	challenger: CloudBackendTarget,
	policy: StabilityPolicy,
	ttlSeconds: TtlSeconds,
	registeredTtlSeconds: TtlSeconds,
	swapsInWindow: NonNegativeCount,
	flipWindowStartMs: Schema.NullOr(EpochMs),
	lastCompletedAtMs: Schema.NullOr(EpochMs),
});

export const RampingRouteState = Schema.TaggedStruct("Ramping", {
	incumbent: CloudBackendTarget,
	challenger: CloudBackendTarget,
	targetWeightPercent: RampWeightPercent,
	policy: StabilityPolicy,
	ttlSeconds: TtlSeconds,
	registeredTtlSeconds: TtlSeconds,
	swapsInWindow: NonNegativeCount,
	flipWindowStartMs: Schema.NullOr(EpochMs),
	lastCompletedAtMs: Schema.NullOr(EpochMs),
});

export const RolledBackRouteState = Schema.TaggedStruct("RolledBack", {
	incumbent: CloudBackendTarget,
	policy: StabilityPolicy,
	ttlSeconds: TtlSeconds,
	swapsInWindow: NonNegativeCount,
	flipWindowStartMs: Schema.NullOr(EpochMs),
	lastCompletedAtMs: Schema.NullOr(EpochMs),
	lastRollbackAtMs: Schema.NullOr(EpochMs),
	reason: NonEmptyReason,
});

export const ReconciliationRequiredRouteState = Schema.TaggedStruct(
	"ReconciliationRequired",
	{
		incumbent: Schema.NullOr(CloudBackendTarget),
		policy: Schema.NullOr(StabilityPolicy),
		ttlSeconds: Schema.NullOr(TtlSeconds),
		swapsInWindow: NonNegativeCount,
		lastCompletedAtMs: Schema.NullOr(EpochMs),
		reason: NonEmptyReason,
	},
);

export const TrafficRouteState = Schema.Union([
	UnregisteredRouteState,
	SteadyRouteState,
	TtlLoweringRouteState,
	RampingRouteState,
	RolledBackRouteState,
	ReconciliationRequiredRouteState,
]);
export type TrafficRouteState = typeof TrafficRouteState.Type;

const ZERO_COUNT = decodeNonNegativeCount(0);
const ZERO_WEIGHT = Schema.decodeSync(RampWeightPercent)(0);

const INITIAL_TRAFFIC_ROUTE_STATE: TrafficRouteState = {
	_tag: "Unregistered",
};

function sameTarget(left: CloudBackendTarget, right: CloudBackendTarget): boolean {
	return left.provider === right.provider && left.backendId === right.backendId;
}

type SwapWindowState = {
	swapsInWindow: NonNegativeCount;
	flipWindowStartMs: EpochMs | null;
	policy: StabilityPolicy;
};

function decayFlipWindow(
	state: SwapWindowState,
	nowMs: EpochMs,
): SwapWindowState {
	if (
		state.flipWindowStartMs !== null &&
		nowMs - state.flipWindowStartMs > state.policy.flipWindowMs
	) {
		return {
			...state,
			swapsInWindow: ZERO_COUNT,
			flipWindowStartMs: null,
		};
	}
	return state;
}

interface SwapWindowAfterCompletion {
	readonly swapsInWindow: NonNegativeCount;
	readonly flipWindowStartMs: EpochMs;
}

function swapsAfterCompletion(
	state: SwapWindowState,
	completedAtMs: EpochMs,
): SwapWindowAfterCompletion {
	const decayed = decayFlipWindow(state, completedAtMs);
	if (
		decayed.flipWindowStartMs === null ||
		completedAtMs - decayed.flipWindowStartMs > decayed.policy.flipWindowMs
	) {
		return {
			swapsInWindow: decodeNonNegativeCount(1),
			flipWindowStartMs: completedAtMs,
		};
	}
	return {
		swapsInWindow: decodeNonNegativeCount(decayed.swapsInWindow + 1),
		flipWindowStartMs: decayed.flipWindowStartMs,
	};
}

export class TrafficRoute extends Domain.Aggregate("TrafficRoute", {
	id: TrafficRouteId,
	state: TrafficRouteState,
	initial: INITIAL_TRAFFIC_ROUTE_STATE,
	commands: [
		RegisterTrafficIncumbent,
		ProposeBudgetMigration,
		RecordTtlLowered,
		RecordRampStep,
		CompleteTrafficCutover,
		RollbackTrafficCutover,
		FlagCutoverReconciliation,
		ResolveTrafficCutoverReconciliation,
	],
	decide: {
		RegisterTrafficIncumbent: (state, cmd) => {
			if (state._tag === "ReconciliationRequired") {
				return new CutoverPreconditionRefused({
					reason: "reconciliation-pending",
				});
			}
			if (state._tag === "Steady" || state._tag === "RolledBack") {
				return new CutoverPreconditionRefused({
					reason: "incumbent-already-registered",
				});
			}
			if (state._tag === "TtlLowering" || state._tag === "Ramping") {
				return new CutoverPreconditionRefused({
					reason: "cutover-already-in-progress",
				});
			}
			return [
				new TrafficIncumbentRegistered({
					incumbent: cmd.incumbent,
					ttlSeconds: cmd.ttlSeconds,
					policy: cmd.policy,
				}),
			];
		},
		ProposeBudgetMigration: (state, cmd) => {
			switch (state._tag) {
				case "Unregistered":
					return new CutoverPreconditionRefused({
						reason: "incumbent-not-registered",
					});
				case "ReconciliationRequired":
					return new CutoverPreconditionRefused({
						reason: "reconciliation-pending",
					});
				case "TtlLowering":
				case "Ramping":
					return new CutoverPreconditionRefused({
						reason: "cutover-already-in-progress",
					});
				case "Steady":
				case "RolledBack": {
					const windowed = decayFlipWindow(
						{
							swapsInWindow: state.swapsInWindow,
							flipWindowStartMs: state.flipWindowStartMs,
							policy: state.policy,
						},
						cmd.nowMs,
					);
					if (sameTarget(state.incumbent, cmd.to)) {
						return new CutoverPreconditionRefused({
							reason: "target-matches-incumbent",
						});
					}
					if (!cmd.preconditionsMet) {
						return new CutoverPreconditionRefused({
							reason: "preconditions-failed",
						});
					}
					if (
						state.lastCompletedAtMs !== null &&
						cmd.nowMs < state.lastCompletedAtMs + state.policy.cooldownMs
					) {
						return new CutoverCooldownActive({
							nextAllowedAtMs: decodeEpochMs(
								state.lastCompletedAtMs + state.policy.cooldownMs,
							),
							nowMs: cmd.nowMs,
						});
					}
					if (
						state._tag === "RolledBack" &&
						state.lastRollbackAtMs !== null &&
						cmd.nowMs < state.lastRollbackAtMs + state.policy.rollbackCooldownMs
					) {
						return new CutoverCooldownActive({
							nextAllowedAtMs: decodeEpochMs(
								state.lastRollbackAtMs + state.policy.rollbackCooldownMs,
							),
							nowMs: cmd.nowMs,
						});
					}
					if (windowed.swapsInWindow >= state.policy.maxSwapsPerWindow) {
						return new CutoverFlipLimitExceeded({
							swapsInWindow: windowed.swapsInWindow,
							maxSwapsPerWindow: state.policy.maxSwapsPerWindow,
						});
					}
					return [
						new BudgetMigrationProposed({
							from: state.incumbent,
							to: cmd.to,
							reason: cmd.reason,
							proposedAtMs: cmd.nowMs,
							previousTtlSeconds: state.ttlSeconds,
						}),
					];
				}
			}
		},
		RecordTtlLowered: (state, cmd) => {
			if (state._tag !== "TtlLowering") {
				return new CutoverNotInProgress({ phase: state._tag });
			}
			if (cmd.evidence.previousTtlSeconds !== state.registeredTtlSeconds) {
				return new CutoverPreconditionRefused({
					reason: "ttl-not-lowered",
				});
			}
			if (cmd.evidence.loweredTtlSeconds >= cmd.evidence.previousTtlSeconds) {
				return new CutoverPreconditionRefused({
					reason: "ttl-not-lowered",
				});
			}
			return [
				new CutoverTtlLowered({
					ttlSeconds: cmd.evidence.loweredTtlSeconds,
				}),
			];
		},
		RecordRampStep: (state, cmd) => {
			if (state._tag !== "Ramping") {
				return new CutoverNotInProgress({ phase: state._tag });
			}
			if (cmd.targetWeightPercent <= state.targetWeightPercent) {
				return new CutoverPreconditionRefused({
					reason: "ramp-not-monotonic",
				});
			}
			return [
				new CutoverRampAdvanced({
					targetWeightPercent: cmd.targetWeightPercent,
					to: state.challenger,
				}),
			];
		},
		CompleteTrafficCutover: (state, cmd) => {
			if (state._tag !== "Ramping") {
				return new CutoverNotInProgress({ phase: state._tag });
			}
			if (state.targetWeightPercent !== 100) {
				return new CutoverPreconditionRefused({
					reason: "ramp-incomplete",
				});
			}
			const nextWindow = swapsAfterCompletion(
				{
					swapsInWindow: state.swapsInWindow,
					flipWindowStartMs: state.flipWindowStartMs,
					policy: state.policy,
				},
				cmd.completedAtMs,
			);
			return [
				new CutoverCompleted({
					incumbent: state.challenger,
					completedAtMs: cmd.completedAtMs,
					swapsInWindow: nextWindow.swapsInWindow,
				}),
			];
		},
		RollbackTrafficCutover: (state, cmd) => {
			if (state._tag !== "TtlLowering" && state._tag !== "Ramping") {
				return new CutoverNotInProgress({ phase: state._tag });
			}
			return [
				new CutoverRolledBack({
					restored: state.incumbent,
					reason: cmd.reason,
					rolledBackAtMs: cmd.rolledBackAtMs,
					restoredTtlSeconds: state.registeredTtlSeconds,
				}),
			];
		},
		FlagCutoverReconciliation: (_state, cmd) => [
			new CutoverReconciliationRequired({ reason: cmd.reason }),
		],
		ResolveTrafficCutoverReconciliation: (state, cmd) => {
			if (state._tag !== "ReconciliationRequired") {
				return new CutoverPreconditionRefused({
					reason: "not-awaiting-reconciliation",
				});
			}
			if (
				state.incumbent === null ||
				state.policy === null ||
				state.ttlSeconds === null
			) {
				return new CutoverPreconditionRefused({
					reason: "incumbent-not-registered",
				});
			}
			return [
				new CutoverReconciliationResolved({
					incumbent: state.incumbent,
					ttlSeconds: state.ttlSeconds,
					policy: state.policy,
					resolvedAtMs: cmd.resolvedAtMs,
				}),
			];
		},
	},
	evolve: {
		TrafficIncumbentRegistered: (state, event) => ({
			_tag: "Steady" as const,
			incumbent: event.incumbent,
			policy: event.policy,
			ttlSeconds: event.ttlSeconds,
			swapsInWindow:
				state._tag === "Unregistered" ? ZERO_COUNT : state.swapsInWindow,
			flipWindowStartMs:
				state._tag === "Unregistered" || state._tag === "ReconciliationRequired"
					? null
					: state.flipWindowStartMs,
			lastCompletedAtMs:
				state._tag === "Unregistered" || state._tag === "ReconciliationRequired"
					? null
					: state.lastCompletedAtMs,
		}),
		BudgetMigrationProposed: (state, event) => {
			if (state._tag !== "Steady" && state._tag !== "RolledBack") {
				return state;
			}
			return {
				_tag: "TtlLowering" as const,
				incumbent: state.incumbent,
				challenger: event.to,
				policy: state.policy,
				ttlSeconds: state.ttlSeconds,
				registeredTtlSeconds: event.previousTtlSeconds,
				swapsInWindow: state.swapsInWindow,
				flipWindowStartMs: state.flipWindowStartMs,
				lastCompletedAtMs: state.lastCompletedAtMs,
			};
		},
		CutoverTtlLowered: (state, event) => {
			if (state._tag !== "TtlLowering" && state._tag !== "Ramping") {
				return state;
			}
			return {
				_tag: "Ramping" as const,
				incumbent: state.incumbent,
				challenger: state.challenger,
				targetWeightPercent:
					state._tag === "Ramping" ? state.targetWeightPercent : ZERO_WEIGHT,
				policy: state.policy,
				ttlSeconds: event.ttlSeconds,
				registeredTtlSeconds: state.registeredTtlSeconds,
				swapsInWindow: state.swapsInWindow,
				flipWindowStartMs: state.flipWindowStartMs,
				lastCompletedAtMs: state.lastCompletedAtMs,
			};
		},
		CutoverRampAdvanced: (state, event) => {
			if (state._tag !== "TtlLowering" && state._tag !== "Ramping") {
				return state;
			}
			return {
				_tag: "Ramping" as const,
				incumbent: state.incumbent,
				challenger: state.challenger,
				targetWeightPercent: event.targetWeightPercent,
				policy: state.policy,
				ttlSeconds: state.ttlSeconds,
				registeredTtlSeconds: state.registeredTtlSeconds,
				swapsInWindow: state.swapsInWindow,
				flipWindowStartMs: state.flipWindowStartMs,
				lastCompletedAtMs: state.lastCompletedAtMs,
			};
		},
		CutoverCompleted: (state, event) => {
			if (state._tag !== "Ramping") {
				return state;
			}
			const nextWindow = swapsAfterCompletion(
				{
					swapsInWindow: state.swapsInWindow,
					flipWindowStartMs: state.flipWindowStartMs,
					policy: state.policy,
				},
				event.completedAtMs,
			);
			return {
				_tag: "Steady" as const,
				incumbent: event.incumbent,
				policy: state.policy,
				ttlSeconds: state.ttlSeconds,
				swapsInWindow: nextWindow.swapsInWindow,
				flipWindowStartMs: nextWindow.flipWindowStartMs,
				lastCompletedAtMs: event.completedAtMs,
			};
		},
		CutoverRolledBack: (state, event) => {
			if (state._tag !== "TtlLowering" && state._tag !== "Ramping") {
				return state;
			}
			return {
				_tag: "RolledBack" as const,
				incumbent: event.restored,
				policy: state.policy,
				ttlSeconds: event.restoredTtlSeconds,
				swapsInWindow: state.swapsInWindow,
				flipWindowStartMs: state.flipWindowStartMs,
				lastCompletedAtMs: state.lastCompletedAtMs,
				lastRollbackAtMs: event.rolledBackAtMs,
				reason: event.reason,
			};
		},
		CutoverReconciliationRequired: (state, event) => ({
			_tag: "ReconciliationRequired" as const,
			incumbent:
				state._tag === "Unregistered"
					? null
					: state._tag === "ReconciliationRequired"
						? state.incumbent
						: state.incumbent,
			policy:
				state._tag === "Unregistered"
					? null
					: state._tag === "ReconciliationRequired"
						? state.policy
						: state.policy,
			ttlSeconds:
				state._tag === "Unregistered"
					? null
					: state._tag === "ReconciliationRequired"
						? state.ttlSeconds
						: state.ttlSeconds,
			swapsInWindow:
				state._tag === "Unregistered" ? ZERO_COUNT : state.swapsInWindow,
			lastCompletedAtMs:
				state._tag === "Unregistered" ? null : state.lastCompletedAtMs,
			reason: event.reason,
		}),
		CutoverReconciliationResolved: (state, event) => ({
			_tag: "Steady" as const,
			incumbent: event.incumbent,
			policy: event.policy,
			ttlSeconds: event.ttlSeconds,
			swapsInWindow:
				state._tag === "ReconciliationRequired"
					? state.swapsInWindow
					: ZERO_COUNT,
			flipWindowStartMs: null,
			lastCompletedAtMs: event.resolvedAtMs,
		}),
	},
}) {}
