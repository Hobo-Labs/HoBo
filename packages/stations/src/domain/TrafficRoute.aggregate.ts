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
}) {}

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
			ttlSeconds: TtlSeconds,
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

export const UnregisteredRouteState = Schema.TaggedStruct("Unregistered", {});

export const SteadyRouteState = Schema.TaggedStruct("Steady", {
	incumbent: CloudBackendTarget,
	policy: StabilityPolicy,
	ttlSeconds: TtlSeconds,
	swapsInWindow: NonNegativeCount,
	lastCompletedAtMs: Schema.NullOr(EpochMs),
});

export const TtlLoweringRouteState = Schema.TaggedStruct("TtlLowering", {
	incumbent: CloudBackendTarget,
	challenger: CloudBackendTarget,
	policy: StabilityPolicy,
	ttlSeconds: TtlSeconds,
	swapsInWindow: NonNegativeCount,
	lastCompletedAtMs: Schema.NullOr(EpochMs),
});

export const RampingRouteState = Schema.TaggedStruct("Ramping", {
	incumbent: CloudBackendTarget,
	challenger: CloudBackendTarget,
	targetWeightPercent: RampWeightPercent,
	policy: StabilityPolicy,
	ttlSeconds: TtlSeconds,
	swapsInWindow: NonNegativeCount,
	lastCompletedAtMs: Schema.NullOr(EpochMs),
});

export const RolledBackRouteState = Schema.TaggedStruct("RolledBack", {
	incumbent: CloudBackendTarget,
	policy: StabilityPolicy,
	ttlSeconds: TtlSeconds,
	swapsInWindow: NonNegativeCount,
	lastCompletedAtMs: Schema.NullOr(EpochMs),
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

function sameTarget(
	left: CloudBackendTarget,
	right: CloudBackendTarget,
): boolean {
	return left.provider === right.provider && left.backendId === right.backendId;
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
	],
	decide: {
		RegisterTrafficIncumbent: (state, cmd) => {
			if (state._tag === "ReconciliationRequired") {
				return new CutoverPreconditionRefused({
					reason: "reconciliation-pending",
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
					if (state.swapsInWindow >= state.policy.maxSwapsPerWindow) {
						return new CutoverFlipLimitExceeded({
							swapsInWindow: state.swapsInWindow,
							maxSwapsPerWindow: state.policy.maxSwapsPerWindow,
						});
					}
					return [
						new BudgetMigrationProposed({
							from: state.incumbent,
							to: cmd.to,
							reason: cmd.reason,
							proposedAtMs: cmd.nowMs,
						}),
					];
				}
			}
		},
		RecordTtlLowered: (state, cmd) => {
			if (state._tag !== "TtlLowering") {
				return new CutoverNotInProgress({ phase: state._tag });
			}
			if (cmd.ttlSeconds >= state.ttlSeconds) {
				return new CutoverPreconditionRefused({
					reason: "ttl-not-lowered",
				});
			}
			return [new CutoverTtlLowered({ ttlSeconds: cmd.ttlSeconds })];
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
			return [
				new CutoverCompleted({
					incumbent: state.challenger,
					completedAtMs: cmd.completedAtMs,
					swapsInWindow: decodeNonNegativeCount(state.swapsInWindow + 1),
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
				}),
			];
		},
		FlagCutoverReconciliation: (_state, cmd) => [
			new CutoverReconciliationRequired({ reason: cmd.reason }),
		],
	},
	evolve: {
		TrafficIncumbentRegistered: (state, event) => ({
			_tag: "Steady" as const,
			incumbent: event.incumbent,
			policy: event.policy,
			ttlSeconds: event.ttlSeconds,
			swapsInWindow:
				state._tag === "Unregistered" ? ZERO_COUNT : state.swapsInWindow,
			lastCompletedAtMs:
				state._tag === "Unregistered" ? null : state.lastCompletedAtMs,
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
				swapsInWindow: state.swapsInWindow,
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
				swapsInWindow: state.swapsInWindow,
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
				swapsInWindow: state.swapsInWindow,
				lastCompletedAtMs: state.lastCompletedAtMs,
			};
		},
		CutoverCompleted: (state, event) => {
			if (state._tag !== "Ramping") {
				return state;
			}
			return {
				_tag: "Steady" as const,
				incumbent: event.incumbent,
				policy: state.policy,
				ttlSeconds: state.ttlSeconds,
				swapsInWindow: event.swapsInWindow,
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
				ttlSeconds: state.ttlSeconds,
				swapsInWindow: state.swapsInWindow,
				lastCompletedAtMs: state.lastCompletedAtMs,
				reason: event.reason,
			};
		},
		CutoverReconciliationRequired: (state, event) => ({
			_tag: "ReconciliationRequired" as const,
			incumbent: state._tag === "Unregistered" ? null : state.incumbent,
			policy: state._tag === "Unregistered" ? null : state.policy,
			ttlSeconds: state._tag === "Unregistered" ? null : state.ttlSeconds,
			swapsInWindow:
				state._tag === "Unregistered" ? ZERO_COUNT : state.swapsInWindow,
			lastCompletedAtMs:
				state._tag === "Unregistered" ? null : state.lastCompletedAtMs,
			reason: event.reason,
		}),
	},
}) {}
