import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
	CloudBackendId,
	CloudProviderKind,
	CutoverPhase,
	TrafficRouteId,
} from "./ids.js";

export class CutoverCooldownActive extends Domain.Rejection(
	"CutoverCooldownActive",
	{
		nextAllowedAtMs: Schema.Int,
		nowMs: Schema.Int,
	},
) {}

export class CutoverFlipLimitExceeded extends Domain.Rejection(
	"CutoverFlipLimitExceeded",
	{
		swapsInWindow: Schema.Int,
		maxSwapsPerWindow: Schema.Int,
	},
) {}

export class CutoverPreconditionRefused extends Domain.Rejection(
	"CutoverPreconditionRefused",
	{
		reason: Schema.String,
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
		provider: CloudProviderKind,
		backendId: CloudBackendId,
		ttlSeconds: Schema.Int,
		cooldownMs: Schema.Int,
		maxSwapsPerWindow: Schema.Int,
	},
) {}

export class BudgetMigrationProposed extends Domain.Event(
	"BudgetMigrationProposed",
	{
		fromProvider: CloudProviderKind,
		fromBackendId: CloudBackendId,
		toProvider: CloudProviderKind,
		toBackendId: CloudBackendId,
		reason: Schema.String,
		proposedAtMs: Schema.Int,
	},
) {}

export class CutoverTtlLowered extends Domain.Event("CutoverTtlLowered", {
	ttlSeconds: Schema.Int,
}) {}

export class CutoverRampAdvanced extends Domain.Event("CutoverRampAdvanced", {
	targetWeightPercent: Schema.Int,
	toProvider: CloudProviderKind,
	toBackendId: CloudBackendId,
}) {}

export class CutoverCompleted extends Domain.Event("CutoverCompleted", {
	activeProvider: CloudProviderKind,
	activeBackendId: CloudBackendId,
	completedAtMs: Schema.Int,
}) {}

export class CutoverRolledBack extends Domain.Event("CutoverRolledBack", {
	restoredProvider: CloudProviderKind,
	restoredBackendId: CloudBackendId,
	reason: Schema.String,
}) {}

export class CutoverReconciliationRequired extends Domain.Event(
	"CutoverReconciliationRequired",
	{
		reason: Schema.String,
	},
) {}

export class RegisterTrafficIncumbent extends Domain.Command(
	"RegisterTrafficIncumbent",
	{
		target: TrafficRouteId,
		input: {
			provider: CloudProviderKind,
			backendId: CloudBackendId,
			ttlSeconds: Schema.Int,
			cooldownMs: Schema.Int,
			maxSwapsPerWindow: Schema.Int,
		},
		events: [TrafficIncumbentRegistered],
		rejects: [],
	},
	{ description: "Register the incumbent cloud provider and stability policy for a traffic route." },
) {}

export class ProposeBudgetMigration extends Domain.Command(
	"ProposeBudgetMigration",
	{
		target: TrafficRouteId,
		input: {
			toProvider: CloudProviderKind,
			toBackendId: CloudBackendId,
			reason: Schema.String,
			nowMs: Schema.Int,
			preconditionsMet: Schema.Boolean,
		},
		events: [BudgetMigrationProposed],
		rejects: [
			CutoverPreconditionRefused,
			CutoverCooldownActive,
			CutoverFlipLimitExceeded,
		],
	},
	{ description: "Propose a budget-driven progressive migration between cloud providers such as Vercel and Cloudflare." },
) {}

export class RecordTtlLowered extends Domain.Command(
	"RecordTtlLowered",
	{
		target: TrafficRouteId,
		input: {
			ttlSeconds: Schema.Int,
		},
		events: [CutoverTtlLowered],
		rejects: [CutoverNotInProgress],
	},
	{ description: "Record that DNS TTL has been lowered prior to progressive traffic ramp." },
) {}

export class RecordRampStep extends Domain.Command(
	"RecordRampStep",
	{
		target: TrafficRouteId,
		input: {
			targetWeightPercent: Schema.Int,
		},
		events: [CutoverRampAdvanced],
		rejects: [CutoverNotInProgress],
	},
	{ description: "Record an observed healthy traffic weight ramp step." },
) {}

export class CompleteTrafficCutover extends Domain.Command(
	"CompleteTrafficCutover",
	{
		target: TrafficRouteId,
		input: {
			completedAtMs: Schema.Int,
		},
		events: [CutoverCompleted],
		rejects: [CutoverNotInProgress],
	},
	{ description: "Complete progressive cutover and promote challenger backend to incumbent." },
) {}

export class RollbackTrafficCutover extends Domain.Command(
	"RollbackTrafficCutover",
	{
		target: TrafficRouteId,
		input: {
			reason: Schema.String,
		},
		events: [CutoverRolledBack],
		rejects: [CutoverNotInProgress],
	},
	{ description: "Roll back progressive cutover to the incumbent backend." },
) {}

export class FlagCutoverReconciliation extends Domain.Command(
	"FlagCutoverReconciliation",
	{
		target: TrafficRouteId,
		input: {
			reason: Schema.String,
		},
		events: [CutoverReconciliationRequired],
		rejects: [],
	},
	{ description: "Flag ambiguous noRollback provider failure for manual or automated reconciliation." },
) {}

const TrafficRouteState = Schema.Struct({
	phase: CutoverPhase,
	activeProvider: Schema.NullOr(CloudProviderKind),
	activeBackendId: Schema.NullOr(CloudBackendId),
	challengerProvider: Schema.NullOr(CloudProviderKind),
	challengerBackendId: Schema.NullOr(CloudBackendId),
	targetWeightPercent: Schema.Int,
	ttlSeconds: Schema.Int,
	cooldownMs: Schema.Int,
	maxSwapsPerWindow: Schema.Int,
	swapsInWindow: Schema.Int,
	lastCompletedAtMs: Schema.NullOr(Schema.Int),
	reconciliationReason: Schema.NullOr(Schema.String),
});

export class TrafficRoute extends Domain.Aggregate("TrafficRoute", {
	id: TrafficRouteId,
	state: TrafficRouteState,
	initial: {
		phase: "unregistered" as const,
		activeProvider: null,
		activeBackendId: null,
		challengerProvider: null,
		challengerBackendId: null,
		targetWeightPercent: 0,
		ttlSeconds: 300,
		cooldownMs: 60_000,
		maxSwapsPerWindow: 3,
		swapsInWindow: 0,
		lastCompletedAtMs: null,
		reconciliationReason: null,
	},
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
		RegisterTrafficIncumbent: (_state, cmd) => [
			new TrafficIncumbentRegistered({
				provider: cmd.provider,
				backendId: cmd.backendId,
				ttlSeconds: Math.max(5, cmd.ttlSeconds),
				cooldownMs: Math.max(0, cmd.cooldownMs),
				maxSwapsPerWindow: Math.max(1, cmd.maxSwapsPerWindow),
			}),
		],
		ProposeBudgetMigration: (state, cmd) => {
			if (state.activeProvider === null || state.activeBackendId === null) {
				return new CutoverPreconditionRefused({
					reason: "incumbent-not-registered",
				});
			}
			if (state.phase === "reconciliation-required") {
				return new CutoverPreconditionRefused({
					reason: "reconciliation-pending",
				});
			}
			if (!cmd.preconditionsMet) {
				return new CutoverPreconditionRefused({
					reason: "preconditions-failed",
				});
			}
			if (
				state.lastCompletedAtMs !== null &&
				cmd.nowMs < state.lastCompletedAtMs + state.cooldownMs
			) {
				return new CutoverCooldownActive({
					nextAllowedAtMs: state.lastCompletedAtMs + state.cooldownMs,
					nowMs: cmd.nowMs,
				});
			}
			if (state.swapsInWindow >= state.maxSwapsPerWindow) {
				return new CutoverFlipLimitExceeded({
					swapsInWindow: state.swapsInWindow,
					maxSwapsPerWindow: state.maxSwapsPerWindow,
				});
			}
			return [
				new BudgetMigrationProposed({
					fromProvider: state.activeProvider,
					fromBackendId: state.activeBackendId,
					toProvider: cmd.toProvider,
					toBackendId: cmd.toBackendId,
					reason: cmd.reason,
					proposedAtMs: cmd.nowMs,
				}),
			];
		},
		RecordTtlLowered: (state, cmd) => {
			if (state.phase !== "ttl-lowering" && state.phase !== "ramping") {
				return new CutoverNotInProgress({ phase: state.phase });
			}
			return [new CutoverTtlLowered({ ttlSeconds: Math.max(5, cmd.ttlSeconds) })];
		},
		RecordRampStep: (state, cmd) => {
			if (
				(state.phase !== "ttl-lowering" && state.phase !== "ramping") ||
				state.challengerProvider === null ||
				state.challengerBackendId === null
			) {
				return new CutoverNotInProgress({ phase: state.phase });
			}
			return [
				new CutoverRampAdvanced({
					targetWeightPercent: Math.max(
						0,
						Math.min(100, cmd.targetWeightPercent),
					),
					toProvider: state.challengerProvider,
					toBackendId: state.challengerBackendId,
				}),
			];
		},
		CompleteTrafficCutover: (state, cmd) => {
			if (
				state.phase !== "ramping" ||
				state.challengerProvider === null ||
				state.challengerBackendId === null
			) {
				return new CutoverNotInProgress({ phase: state.phase });
			}
			return [
				new CutoverCompleted({
					activeProvider: state.challengerProvider,
					activeBackendId: state.challengerBackendId,
					completedAtMs: cmd.completedAtMs,
				}),
			];
		},
		RollbackTrafficCutover: (state, cmd) => {
			if (
				(state.phase !== "ttl-lowering" && state.phase !== "ramping") ||
				state.activeProvider === null ||
				state.activeBackendId === null
			) {
				return new CutoverNotInProgress({ phase: state.phase });
			}
			return [
				new CutoverRolledBack({
					restoredProvider: state.activeProvider,
					restoredBackendId: state.activeBackendId,
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
			...state,
			phase: "steady" as const,
			activeProvider: event.provider,
			activeBackendId: event.backendId,
			ttlSeconds: event.ttlSeconds,
			cooldownMs: event.cooldownMs,
			maxSwapsPerWindow: event.maxSwapsPerWindow,
		}),
		BudgetMigrationProposed: (state, event) => ({
			...state,
			phase: "ttl-lowering" as const,
			challengerProvider: event.toProvider,
			challengerBackendId: event.toBackendId,
			targetWeightPercent: 0,
		}),
		CutoverTtlLowered: (state, event) => ({
			...state,
			phase: "ramping" as const,
			ttlSeconds: event.ttlSeconds,
		}),
		CutoverRampAdvanced: (state, event) => ({
			...state,
			phase: "ramping" as const,
			targetWeightPercent: event.targetWeightPercent,
		}),
		CutoverCompleted: (state, event) => ({
			...state,
			phase: "steady" as const,
			activeProvider: event.activeProvider,
			activeBackendId: event.activeBackendId,
			challengerProvider: null,
			challengerBackendId: null,
			targetWeightPercent: 100,
			swapsInWindow: state.swapsInWindow + 1,
			lastCompletedAtMs: event.completedAtMs,
		}),
		CutoverRolledBack: (state) => ({
			...state,
			phase: "rolled-back" as const,
			challengerProvider: null,
			challengerBackendId: null,
			targetWeightPercent: 0,
		}),
		CutoverReconciliationRequired: (state, event) => ({
			...state,
			phase: "reconciliation-required" as const,
			reconciliationReason: event.reason,
		}),
	},
}) {}
