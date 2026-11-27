import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
	ApproverId,
	DeliveryRunId,
	EpochMs,
	FreightAlias,
	FreightArtifactRef,
	FreightDigest,
	NonEmptyReason,
	StageId,
	WarehouseId,
} from "./ids.js";

export const StageQualificationRecord = Schema.Struct({
	stageId: StageId,
	deliveryRunId: DeliveryRunId,
	qualifiedAtMs: EpochMs,
	summary: NonEmptyReason,
});
export type StageQualificationRecord = typeof StageQualificationRecord.Type;

export const StageManualApprovalRecord = Schema.Struct({
	stageId: StageId,
	approver: ApproverId,
	reason: NonEmptyReason,
	approvedAtMs: EpochMs,
	expiresAtMs: EpochMs,
});
export type StageManualApprovalRecord = typeof StageManualApprovalRecord.Type;

export class FreightAlreadyRecorded extends Domain.Rejection(
	"FreightAlreadyRecorded",
	{
		alias: FreightAlias,
	},
) {}

export class FreightNotRecorded extends Domain.Rejection(
	"FreightNotRecorded",
	{},
) {}

export class FreightAlreadyYanked extends Domain.Rejection(
	"FreightAlreadyYanked",
	{
		reason: NonEmptyReason,
	},
) {}

export class ApprovalExpiryInvalid extends Domain.Rejection(
	"ApprovalExpiryInvalid",
	{
		approvedAtMs: EpochMs,
		expiresAtMs: EpochMs,
	},
) {}

export class FreightRecorded extends Domain.Event("FreightRecorded", {
	warehouseId: WarehouseId,
	alias: FreightAlias,
	artifacts: Schema.NonEmptyArray(FreightArtifactRef),
	recordedAtMs: EpochMs,
}) {}

export class FreightAliasUpdated extends Domain.Event("FreightAliasUpdated", {
	previousAlias: FreightAlias,
	alias: FreightAlias,
}) {}

export class FreightQualifiedInStage extends Domain.Event(
	"FreightQualifiedInStage",
	{
		stageId: StageId,
		deliveryRunId: DeliveryRunId,
		qualifiedAtMs: EpochMs,
		summary: NonEmptyReason,
	},
) {}

export class FreightManuallyApproved extends Domain.Event(
	"FreightManuallyApproved",
	{
		stageId: StageId,
		approver: ApproverId,
		reason: NonEmptyReason,
		approvedAtMs: EpochMs,
		expiresAtMs: EpochMs,
	},
) {}

export class FreightYanked extends Domain.Event("FreightYanked", {
	reason: NonEmptyReason,
	yankedAtMs: EpochMs,
}) {}

export class RecordFreight extends Domain.Command(
	"RecordFreight",
	{
		target: FreightDigest,
		input: {
			warehouseId: WarehouseId,
			alias: FreightAlias,
			artifacts: Schema.NonEmptyArray(FreightArtifactRef),
			recordedAtMs: EpochMs,
		},
		events: [FreightRecorded],
		rejects: [FreightAlreadyRecorded],
	},
	{
		description:
			"Record an immutable content-addressed Freight bundle discovered from a Warehouse.",
	},
) {}

export class SetFreightAlias extends Domain.Command(
	"SetFreightAlias",
	{
		target: FreightDigest,
		input: {
			alias: FreightAlias,
		},
		events: [FreightAliasUpdated],
		rejects: [FreightNotRecorded, FreightAlreadyYanked],
	},
	{
		description:
			"Assign or update the human-readable alias for an active Freight bundle.",
	},
) {}

export class RecordFreightQualification extends Domain.Command(
	"RecordFreightQualification",
	{
		target: FreightDigest,
		input: {
			stageId: StageId,
			deliveryRunId: DeliveryRunId,
			qualifiedAtMs: EpochMs,
			summary: NonEmptyReason,
		},
		events: [FreightQualifiedInStage],
		rejects: [FreightNotRecorded, FreightAlreadyYanked],
	},
	{
		description:
			"Record verified qualification of a Freight bundle in a Stage to unlock downstream lineage.",
	},
) {}

export class ApproveFreightForStage extends Domain.Command(
	"ApproveFreightForStage",
	{
		target: FreightDigest,
		input: {
			stageId: StageId,
			approver: ApproverId,
			reason: NonEmptyReason,
			approvedAtMs: EpochMs,
			expiresAtMs: EpochMs,
		},
		events: [FreightManuallyApproved],
		rejects: [FreightNotRecorded, FreightAlreadyYanked, ApprovalExpiryInvalid],
	},
	{
		description:
			"Grant an expiring manual approval allowing Freight to bypass upstream verification for one Stage.",
	},
) {}

export class YankFreight extends Domain.Command(
	"YankFreight",
	{
		target: FreightDigest,
		input: {
			reason: NonEmptyReason,
			yankedAtMs: EpochMs,
		},
		events: [FreightYanked],
		rejects: [FreightNotRecorded, FreightAlreadyYanked],
	},
	{
		description: "Mark a Freight bundle unusable for future Stage promotions.",
	},
) {}

export const CdFreightState = Schema.Union([
	Schema.TaggedStruct("Unrecorded", {}),
	Schema.TaggedStruct("Active", {
		warehouseId: WarehouseId,
		alias: FreightAlias,
		artifacts: Schema.NonEmptyArray(FreightArtifactRef),
		recordedAtMs: EpochMs,
		qualifications: Schema.Array(StageQualificationRecord),
		approvals: Schema.Array(StageManualApprovalRecord),
	}),
	Schema.TaggedStruct("Yanked", {
		warehouseId: WarehouseId,
		alias: FreightAlias,
		reason: NonEmptyReason,
		yankedAtMs: EpochMs,
	}),
]);
export type CdFreightState = typeof CdFreightState.Type;

export class CdFreight extends Domain.Aggregate("CdFreight", {
	id: FreightDigest,
	state: CdFreightState,
	initial: { _tag: "Unrecorded" },
	commands: [
		RecordFreight,
		SetFreightAlias,
		RecordFreightQualification,
		ApproveFreightForStage,
		YankFreight,
	],
	decide: {
		RecordFreight: (state, cmd) => {
			if (state._tag !== "Unrecorded") {
				return new FreightAlreadyRecorded({ alias: state.alias });
			}
			return [
				new FreightRecorded({
					warehouseId: cmd.warehouseId,
					alias: cmd.alias,
					artifacts: cmd.artifacts,
					recordedAtMs: cmd.recordedAtMs,
				}),
			];
		},
		SetFreightAlias: (state, cmd) => {
			if (state._tag === "Unrecorded") {
				return new FreightNotRecorded({});
			}
			if (state._tag === "Yanked") {
				return new FreightAlreadyYanked({
					reason: state.reason,
				});
			}
			if (state.alias === cmd.alias) return [];
			return [
				new FreightAliasUpdated({
					previousAlias: state.alias,
					alias: cmd.alias,
				}),
			];
		},
		RecordFreightQualification: (state, cmd) => {
			if (state._tag === "Unrecorded") {
				return new FreightNotRecorded({});
			}
			if (state._tag === "Yanked") {
				return new FreightAlreadyYanked({
					reason: state.reason,
				});
			}
			const alreadyQualified = state.qualifications.some(
				(entry) =>
					entry.stageId === cmd.stageId &&
					entry.deliveryRunId === cmd.deliveryRunId,
			);
			if (alreadyQualified) return [];
			return [
				new FreightQualifiedInStage({
					stageId: cmd.stageId,
					deliveryRunId: cmd.deliveryRunId,
					qualifiedAtMs: cmd.qualifiedAtMs,
					summary: cmd.summary,
				}),
			];
		},
		ApproveFreightForStage: (state, cmd) => {
			if (state._tag === "Unrecorded") {
				return new FreightNotRecorded({});
			}
			if (state._tag === "Yanked") {
				return new FreightAlreadyYanked({
					reason: state.reason,
				});
			}
			if (cmd.expiresAtMs <= cmd.approvedAtMs) {
				return new ApprovalExpiryInvalid({
					approvedAtMs: cmd.approvedAtMs,
					expiresAtMs: cmd.expiresAtMs,
				});
			}
			return [
				new FreightManuallyApproved({
					stageId: cmd.stageId,
					approver: cmd.approver,
					reason: cmd.reason,
					approvedAtMs: cmd.approvedAtMs,
					expiresAtMs: cmd.expiresAtMs,
				}),
			];
		},
		YankFreight: (state, cmd) => {
			if (state._tag === "Unrecorded") {
				return new FreightNotRecorded({});
			}
			if (state._tag === "Yanked") {
				return new FreightAlreadyYanked({
					reason: state.reason,
				});
			}
			return [
				new FreightYanked({
					reason: cmd.reason,
					yankedAtMs: cmd.yankedAtMs,
				}),
			];
		},
	},
	evolve: {
		FreightRecorded: (_state, event) => ({
			_tag: "Active" as const,
			warehouseId: event.warehouseId,
			alias: event.alias,
			artifacts: event.artifacts,
			recordedAtMs: event.recordedAtMs,
			qualifications: [],
			approvals: [],
		}),
		FreightAliasUpdated: (state, event) =>
			state._tag === "Active"
				? {
						...state,
						alias: event.alias,
					}
				: state,
		FreightQualifiedInStage: (state, event) =>
			state._tag === "Active"
				? {
						...state,
						qualifications: [
							...state.qualifications,
							{
								stageId: event.stageId,
								deliveryRunId: event.deliveryRunId,
								qualifiedAtMs: event.qualifiedAtMs,
								summary: event.summary,
							},
						],
					}
				: state,
		FreightManuallyApproved: (state, event) =>
			state._tag === "Active"
				? {
						...state,
						approvals: [
							...state.approvals,
							{
								stageId: event.stageId,
								approver: event.approver,
								reason: event.reason,
								approvedAtMs: event.approvedAtMs,
								expiresAtMs: event.expiresAtMs,
							},
						],
					}
				: state,
		FreightYanked: (state, event) =>
			state._tag === "Active"
				? {
						_tag: "Yanked" as const,
						warehouseId: state.warehouseId,
						alias: state.alias,
						reason: event.reason,
						yankedAtMs: event.yankedAtMs,
					}
				: state,
	},
}) {}
