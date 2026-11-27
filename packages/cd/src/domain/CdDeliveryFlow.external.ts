import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
	BranchName,
	CampTargetId,
	DeliveryFlowKind,
	DeliveryFlowTarget,
	DeliveryRunId,
	FreightDigest,
	NonEmptyReason,
	NonNegativeCount,
	PullRequestId,
	PullRequestUrl,
	RevisionRef,
	StageId,
} from "./ids.js";

export class DeliveryFlowFailed extends Domain.Rejection("DeliveryFlowFailed", {
	flowTarget: DeliveryFlowTarget,
	reason: NonEmptyReason,
}) {}

export class UnsupportedDeliveryFlow extends Domain.Rejection(
	"UnsupportedDeliveryFlow",
	{
		flowKind: DeliveryFlowKind,
		flowTarget: DeliveryFlowTarget,
	},
) {}

export const PublishRevisionOutcome = Schema.Union([
	Schema.TaggedStruct("Committed", {
		revision: RevisionRef,
		targetRef: NonEmptyReason,
	}),
	Schema.TaggedStruct("PullRequestOpened", {
		revision: RevisionRef,
		prId: PullRequestId,
		prUrl: PullRequestUrl,
		headBranch: BranchName,
		targetRef: NonEmptyReason,
	}),
]);
export type PublishRevisionOutcome = typeof PublishRevisionOutcome.Type;

export const PullRequestObservation = Schema.Union([
	Schema.TaggedStruct("Open", {
		summary: NonEmptyReason,
	}),
	Schema.TaggedStruct("Merged", {
		mergeRevision: RevisionRef,
		summary: NonEmptyReason,
	}),
	Schema.TaggedStruct("Closed", {
		summary: NonEmptyReason,
	}),
]);
export type PullRequestObservation = typeof PullRequestObservation.Type;

export const ConvergenceObservation = Schema.Union([
	Schema.TaggedStruct("Converged", {
		appliedRevision: RevisionRef,
		summary: NonEmptyReason,
	}),
	Schema.TaggedStruct("Converging", {
		appliedRevision: Schema.NullOr(RevisionRef),
		outOfSyncCount: NonNegativeCount,
		summary: NonEmptyReason,
	}),
	Schema.TaggedStruct("Degraded", {
		appliedRevision: Schema.NullOr(RevisionRef),
		outOfSyncCount: NonNegativeCount,
		summary: NonEmptyReason,
	}),
]);
export type ConvergenceObservation = typeof ConvergenceObservation.Type;

export class CdDeliveryFlow extends Domain.ExternalSystem("CdDeliveryFlow", {
	publishRevision: {
		args: {
			deliveryRunId: DeliveryRunId,
			stageId: StageId,
			campId: CampTargetId,
			freightDigest: FreightDigest,
			flowKind: DeliveryFlowKind,
			flowTarget: DeliveryFlowTarget,
			previousRevision: Schema.NullOr(RevisionRef),
		},
		success: {
			outcome: PublishRevisionOutcome,
		},
		error: [DeliveryFlowFailed, UnsupportedDeliveryFlow],
	},
	observePullRequest: {
		args: {
			deliveryRunId: DeliveryRunId,
			flowKind: DeliveryFlowKind,
			flowTarget: DeliveryFlowTarget,
			prId: PullRequestId,
			targetRef: NonEmptyReason,
		},
		success: {
			observation: PullRequestObservation,
		},
		error: [DeliveryFlowFailed, UnsupportedDeliveryFlow],
	},
	observeConvergence: {
		args: {
			deliveryRunId: DeliveryRunId,
			stageId: StageId,
			campId: CampTargetId,
			flowKind: DeliveryFlowKind,
			flowTarget: DeliveryFlowTarget,
			targetRevision: RevisionRef,
			triggerSync: Schema.Boolean,
		},
		success: {
			observation: ConvergenceObservation,
		},
		error: [DeliveryFlowFailed, UnsupportedDeliveryFlow],
	},
	rollbackRevision: {
		args: {
			deliveryRunId: DeliveryRunId,
			stageId: StageId,
			campId: CampTargetId,
			flowKind: DeliveryFlowKind,
			flowTarget: DeliveryFlowTarget,
			targetRevision: RevisionRef,
			previousRevision: Schema.NullOr(RevisionRef),
			reason: NonEmptyReason,
		},
		success: {
			rolledBack: Schema.Boolean,
			rollbackRevision: Schema.NullOr(RevisionRef),
			summary: NonEmptyReason,
		},
		error: [DeliveryFlowFailed, UnsupportedDeliveryFlow],
	},
}) {}
