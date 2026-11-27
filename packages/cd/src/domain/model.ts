import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
	CdDeliveryRun,
	DeliveryRunApproved,
	DeliveryRunStarted,
	StartDeliveryRun,
} from "./CdDeliveryRun.aggregate.js";
import { CdFanout } from "./CdFanout.aggregate.js";
import {
	CdFreight,
	StageManualApprovalRecord,
	StageQualificationRecord,
} from "./CdFreight.aggregate.js";
import {
	CdPromotion,
	CdPromotionApproved,
	CdPromotionRequested,
} from "./CdPromotion.aggregate.js";
import {
	CdStage,
	CdStageConfig,
	QueuedStagePromotion,
	StagePromotionStarted,
} from "./CdStage.aggregate.js";
import {
	ExecuteCdDeliveryFlow,
	ExecuteCdDeliveryFlowLive,
} from "./ExecuteCdDeliveryFlow.saga.js";
import {
	ExecuteCdPromotion,
	ExecuteCdPromotionLive,
} from "./ExecuteCdPromotion.saga.js";
import {
	ApproverId,
	BranchName,
	CampTargetId,
	DeliveryFlowKind,
	DeliveryFlowTarget,
	DeliveryRunId,
	EpochMs,
	FreightAlias,
	FreightArtifactRef,
	FreightDigest,
	NonEmptyReason,
	NonNegativeCount,
	PullRequestId,
	PullRequestUrl,
	RealizationRef,
	RevisionRef,
	StageId,
	WarehouseId,
} from "./ids.js";

export class StartCdPromotionPolicy extends Domain.Policy(
	"StartCdPromotionPolicy",
	{
		from: CdPromotion,
		on: [CdPromotionRequested, CdPromotionApproved],
	},
) {}

export const StartCdPromotionPolicyLive = StartCdPromotionPolicy.toLayer(
	Effect.gen(function* () {
		const runPromotion = yield* ExecuteCdPromotion;

		return Effect.fn(function* ({ source, event }) {
			if (event._tag === "CdPromotionRequested") {
				if (event.requiresApproval) return;
				yield* runPromotion.start(source, {
					campId: event.campId,
					freightDigest: event.freightDigest,
				});
				return;
			}
			yield* runPromotion.start(source, {
				campId: event.campId,
				freightDigest: event.freightDigest,
			});
		});
	}),
);

export class StagePromotionToDeliveryRunPolicy extends Domain.Policy(
	"StagePromotionToDeliveryRunPolicy",
	{
		from: CdStage,
		on: [StagePromotionStarted],
	},
	{
		description:
			"Starts a CdDeliveryRun aggregate whenever a Stage starts promoting eligible or queued Freight.",
	},
) {}

export const StagePromotionToDeliveryRunPolicyLive =
	StagePromotionToDeliveryRunPolicy.toLayer(
		Effect.gen(function* () {
			const runs = yield* CdDeliveryRun;

			return Effect.fn(function* ({ source, event }) {
				yield* runs
					.send(
						event.deliveryRunId,
						new StartDeliveryRun({
							stageId: source.id,
							campId: event.campId,
							freightDigest: event.freightDigest,
							previousRevision: null,
							flowKind: event.deliveryFlow,
							flowTarget: event.flowTarget,
							requiresApproval: event.requiresApproval,
							implicitHealthVerification: event.implicitHealthVerification,
							triggerPullSync: event.triggerPullSync,
							requestedAtMs: event.requestedAtMs,
						}),
					)
					.pipe(Effect.result, Effect.asVoid);
			});
		}),
	);

export class StartCdDeliveryFlowPolicy extends Domain.Policy(
	"StartCdDeliveryFlowPolicy",
	{
		from: CdDeliveryRun,
		on: [DeliveryRunStarted, DeliveryRunApproved],
	},
	{
		description:
			"Launches the pluggable ExecuteCdDeliveryFlow saga once a delivery run is admitted or approved.",
	},
) {}

export const StartCdDeliveryFlowPolicyLive = StartCdDeliveryFlowPolicy.toLayer(
	Effect.gen(function* () {
		const runFlow = yield* ExecuteCdDeliveryFlow;

		return Effect.fn(function* ({ source, event }) {
			if (event._tag === "DeliveryRunStarted" && event.requiresApproval) {
				return;
			}
			yield* runFlow.start(source, {
				stageId: event.stageId,
				campId: event.campId,
				freightDigest: event.freightDigest,
				previousRevision: event.previousRevision,
				flowKind: event.flowKind,
				flowTarget: event.flowTarget,
				implicitHealthVerification: event.implicitHealthVerification,
				triggerPullSync: event.triggerPullSync,
				requestedAtMs: event.requestedAtMs,
			});
		});
	}),
);

export const CdPromotionStatusState = Schema.Union([
	Schema.TaggedStruct("Idle", {}),
	Schema.TaggedStruct("PendingApproval", {
		campId: CampTargetId,
		freightDigest: FreightDigest,
	}),
	Schema.TaggedStruct("Approved", {
		campId: CampTargetId,
		freightDigest: FreightDigest,
		approver: Schema.NullOr(ApproverId),
	}),
	Schema.TaggedStruct("Realized", {
		campId: CampTargetId,
		freightDigest: FreightDigest,
		approver: Schema.NullOr(ApproverId),
		realizationRef: RealizationRef,
	}),
	Schema.TaggedStruct("Verified", {
		campId: CampTargetId,
		freightDigest: FreightDigest,
		approver: Schema.NullOr(ApproverId),
		realizationRef: RealizationRef,
		summary: NonEmptyReason,
	}),
	Schema.TaggedStruct("Completed", {
		campId: CampTargetId,
		freightDigest: FreightDigest,
		approver: Schema.NullOr(ApproverId),
		realizationRef: RealizationRef,
	}),
	Schema.TaggedStruct("RolledBack", {
		campId: CampTargetId,
		freightDigest: FreightDigest,
		approver: Schema.NullOr(ApproverId),
		realizationRef: RealizationRef,
		reason: NonEmptyReason,
	}),
	Schema.TaggedStruct("Failed", {
		campId: Schema.NullOr(CampTargetId),
		freightDigest: Schema.NullOr(FreightDigest),
		approver: Schema.NullOr(ApproverId),
		realizationRef: Schema.NullOr(RealizationRef),
		reason: NonEmptyReason,
	}),
]);
export type CdPromotionStatusState = typeof CdPromotionStatusState.Type;

export class CdPromotionStatusView extends Domain.View(
	"CdPromotionStatusView",
	{
		from: [CdPromotion],
		key: CdPromotion,
		state: CdPromotionStatusState,
		initial: { _tag: "Idle" },
		evolve: {
			CdPromotionRequested: (_state, event) =>
				event.requiresApproval
					? {
							_tag: "PendingApproval" as const,
							campId: event.campId,
							freightDigest: event.freightDigest,
						}
					: {
							_tag: "Approved" as const,
							campId: event.campId,
							freightDigest: event.freightDigest,
							approver: null,
						},
			CdPromotionApproved: (_state, event) => ({
				_tag: "Approved" as const,
				campId: event.campId,
				freightDigest: event.freightDigest,
				approver: event.approver,
			}),
			CdPromotionRealized: (state, event) =>
				state._tag === "Approved"
					? {
							_tag: "Realized" as const,
							campId: state.campId,
							freightDigest: state.freightDigest,
							approver: state.approver,
							realizationRef: event.realizationRef,
						}
					: state,
			CdPromotionVerified: (state, event) =>
				state._tag === "Realized" && event.passed
					? {
							_tag: "Verified" as const,
							campId: state.campId,
							freightDigest: state.freightDigest,
							approver: state.approver,
							realizationRef: state.realizationRef,
							summary: event.summary,
						}
					: state,
			CdPromotionCompleted: (state, event) =>
				state._tag === "Verified"
					? {
							_tag: "Completed" as const,
							campId: state.campId,
							freightDigest: state.freightDigest,
							approver: state.approver,
							realizationRef: event.realizationRef,
						}
					: state,
			CdPromotionRolledBack: (state, event) =>
				state._tag === "Realized" || state._tag === "Verified"
					? {
							_tag: "RolledBack" as const,
							campId: state.campId,
							freightDigest: state.freightDigest,
							approver: state.approver,
							realizationRef: state.realizationRef,
							reason: event.reason,
						}
					: state,
			CdPromotionFailed: (state, event) => {
				switch (state._tag) {
					case "Idle":
						return {
							_tag: "Failed" as const,
							campId: null,
							freightDigest: null,
							approver: null,
							realizationRef: null,
							reason: event.reason,
						};
					case "PendingApproval":
						return {
							_tag: "Failed" as const,
							campId: state.campId,
							freightDigest: state.freightDigest,
							approver: null,
							realizationRef: null,
							reason: event.reason,
						};
					case "Approved":
						return {
							_tag: "Failed" as const,
							campId: state.campId,
							freightDigest: state.freightDigest,
							approver: state.approver,
							realizationRef: null,
							reason: event.reason,
						};
					case "Realized":
					case "Verified":
					case "Completed":
					case "RolledBack":
					case "Failed":
						return {
							_tag: "Failed" as const,
							campId: state.campId,
							freightDigest: state.freightDigest,
							approver: state.approver,
							realizationRef: state.realizationRef,
							reason: event.reason,
						};
				}
			},
		},
	},
) {}

export const CdFanoutStatusState = Schema.Union([
	Schema.TaggedStruct("Idle", {}),
	Schema.TaggedStruct("Running", {
		totalCamps: NonNegativeCount,
		succeededCount: NonNegativeCount,
		failedCount: NonNegativeCount,
	}),
	Schema.TaggedStruct("Completed", {
		totalCamps: NonNegativeCount,
		succeededCount: NonNegativeCount,
		failedCount: NonNegativeCount,
	}),
	Schema.TaggedStruct("Halted", {
		totalCamps: NonNegativeCount,
		succeededCount: NonNegativeCount,
		failedCount: NonNegativeCount,
		haltReason: NonEmptyReason,
	}),
]);
export type CdFanoutStatusState = typeof CdFanoutStatusState.Type;

export class CdFanoutStatusView extends Domain.View("CdFanoutStatusView", {
	from: [CdFanout],
	key: CdFanout,
	state: CdFanoutStatusState,
	initial: { _tag: "Idle" },
	evolve: {
		CdFanoutStarted: (_state, event) => ({
			_tag: "Running" as const,
			totalCamps: NonNegativeCount.make(event.campIds.length),
			succeededCount: NonNegativeCount.make(0),
			failedCount: NonNegativeCount.make(0),
		}),
		CdFanoutCampUpdated: (state, event) =>
			state._tag === "Running"
				? {
						...state,
						succeededCount: NonNegativeCount.make(
							event.succeeded ? state.succeededCount + 1 : state.succeededCount,
						),
						failedCount: NonNegativeCount.make(
							event.succeeded ? state.failedCount : state.failedCount + 1,
						),
					}
				: state,
		CdFanoutHalted: (state, event) =>
			state._tag === "Running"
				? {
						_tag: "Halted" as const,
						totalCamps: state.totalCamps,
						succeededCount: state.succeededCount,
						failedCount: state.failedCount,
						haltReason: event.reason,
					}
				: state,
		CdFanoutCompleted: (state) =>
			state._tag === "Running"
				? {
						_tag: "Completed" as const,
						totalCamps: state.totalCamps,
						succeededCount: state.succeededCount,
						failedCount: state.failedCount,
					}
				: state,
	},
}) {}

export const CdFreightCatalogState = Schema.Union([
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
export type CdFreightCatalogState = typeof CdFreightCatalogState.Type;

export class CdFreightCatalogView extends Domain.View("CdFreightCatalogView", {
	from: [CdFreight],
	key: CdFreight,
	state: CdFreightCatalogState,
	initial: { _tag: "Unrecorded" },
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

export const CdStageStatusState = Schema.Union([
	Schema.TaggedStruct("Unconfigured", {}),
	Schema.TaggedStruct("Idle", {
		config: CdStageConfig,
		currentFreightDigest: Schema.NullOr(FreightDigest),
		currentVerified: Schema.Boolean,
		lastVerifiedAtMs: Schema.NullOr(EpochMs),
	}),
	Schema.TaggedStruct("Promoting", {
		config: CdStageConfig,
		activeRunId: DeliveryRunId,
		activeFreightDigest: FreightDigest,
		currentFreightDigest: Schema.NullOr(FreightDigest),
		currentVerified: Schema.Boolean,
		lastVerifiedAtMs: Schema.NullOr(EpochMs),
		pending: Schema.NullOr(QueuedStagePromotion),
	}),
	Schema.TaggedStruct("Verifying", {
		config: CdStageConfig,
		activeRunId: DeliveryRunId,
		activeFreightDigest: FreightDigest,
		currentFreightDigest: Schema.NullOr(FreightDigest),
		currentVerified: Schema.Boolean,
		lastVerifiedAtMs: Schema.NullOr(EpochMs),
		pending: Schema.NullOr(QueuedStagePromotion),
	}),
]);
export type CdStageStatusState = typeof CdStageStatusState.Type;

export class CdStageStatusView extends Domain.View("CdStageStatusView", {
	from: [CdStage],
	key: CdStage,
	state: CdStageStatusState,
	initial: { _tag: "Unconfigured" },
	evolve: {
		CdStageConfigured: (state, event) =>
			state._tag === "Unconfigured"
				? {
						_tag: "Idle" as const,
						config: event.config,
						currentFreightDigest: null,
						currentVerified: false,
						lastVerifiedAtMs: null,
					}
				: {
						...state,
						config: event.config,
					},
		StagePromotionStarted: (state, event) =>
			state._tag === "Unconfigured"
				? state
				: {
						_tag: "Promoting" as const,
						config: state.config,
						activeRunId: event.deliveryRunId,
						activeFreightDigest: event.freightDigest,
						currentFreightDigest: state.currentFreightDigest,
						currentVerified: state.currentVerified,
						lastVerifiedAtMs: state.lastVerifiedAtMs,
						pending: null,
					},
		StagePromotionQueued: (state, event) =>
			state._tag === "Promoting" || state._tag === "Verifying"
				? {
						...state,
						pending: {
							deliveryRunId: event.deliveryRunId,
							freightDigest: event.freightDigest,
							requestedAtMs: event.requestedAtMs,
						},
					}
				: state,
		StagePromotionSuperseded: (state) => state,
		StageEnteredVerifying: (state) =>
			state._tag === "Promoting"
				? {
						_tag: "Verifying" as const,
						config: state.config,
						activeRunId: state.activeRunId,
						activeFreightDigest: state.activeFreightDigest,
						currentFreightDigest: state.currentFreightDigest,
						currentVerified: state.currentVerified,
						lastVerifiedAtMs: state.lastVerifiedAtMs,
						pending: state.pending,
					}
				: state,
		StagePromotionCompleted: (state, event) =>
			state._tag === "Promoting" || state._tag === "Verifying"
				? {
						_tag: "Idle" as const,
						config: state.config,
						currentFreightDigest: event.freightDigest,
						currentVerified: true,
						lastVerifiedAtMs: event.qualifiedAtMs,
					}
				: state,
		StagePromotionFailed: (state) =>
			state._tag === "Promoting" || state._tag === "Verifying"
				? {
						_tag: "Idle" as const,
						config: state.config,
						currentFreightDigest: state.currentFreightDigest,
						currentVerified: state.currentVerified,
						lastVerifiedAtMs: state.lastVerifiedAtMs,
					}
				: state,
		StageReverificationStarted: (state, event) =>
			state._tag === "Idle"
				? {
						_tag: "Verifying" as const,
						config: state.config,
						activeRunId: event.deliveryRunId,
						activeFreightDigest: event.freightDigest,
						currentFreightDigest: state.currentFreightDigest,
						currentVerified: state.currentVerified,
						lastVerifiedAtMs: state.lastVerifiedAtMs,
						pending: null,
					}
				: state,
		StageVerificationAborted: (state) =>
			state._tag === "Verifying"
				? {
						_tag: "Idle" as const,
						config: state.config,
						currentFreightDigest: state.currentFreightDigest,
						currentVerified: false,
						lastVerifiedAtMs: state.lastVerifiedAtMs,
					}
				: state,
	},
}) {}

export const CdDeliveryRunStatusState = Schema.Union([
	Schema.TaggedStruct("Idle", {}),
	Schema.TaggedStruct("PendingApproval", {
		stageId: StageId,
		campId: CampTargetId,
		freightDigest: FreightDigest,
		flowKind: DeliveryFlowKind,
		flowTarget: DeliveryFlowTarget,
	}),
	Schema.TaggedStruct("Publishing", {
		stageId: StageId,
		campId: CampTargetId,
		freightDigest: FreightDigest,
		flowKind: DeliveryFlowKind,
		flowTarget: DeliveryFlowTarget,
		approver: Schema.NullOr(ApproverId),
	}),
	Schema.TaggedStruct("AwaitingPullRequest", {
		stageId: StageId,
		campId: CampTargetId,
		freightDigest: FreightDigest,
		flowKind: DeliveryFlowKind,
		flowTarget: DeliveryFlowTarget,
		prId: PullRequestId,
		prUrl: PullRequestUrl,
		headBranch: BranchName,
	}),
	Schema.TaggedStruct("AwaitingConvergence", {
		stageId: StageId,
		campId: CampTargetId,
		freightDigest: FreightDigest,
		flowKind: DeliveryFlowKind,
		flowTarget: DeliveryFlowTarget,
		targetRevision: RevisionRef,
		prId: Schema.NullOr(PullRequestId),
	}),
	Schema.TaggedStruct("Verifying", {
		stageId: StageId,
		campId: CampTargetId,
		freightDigest: FreightDigest,
		flowKind: DeliveryFlowKind,
		flowTarget: DeliveryFlowTarget,
		appliedRevision: RevisionRef,
		prId: Schema.NullOr(PullRequestId),
	}),
	Schema.TaggedStruct("Completed", {
		stageId: StageId,
		campId: CampTargetId,
		freightDigest: FreightDigest,
		flowKind: DeliveryFlowKind,
		flowTarget: DeliveryFlowTarget,
		appliedRevision: RevisionRef,
		qualifiedAtMs: EpochMs,
		summary: NonEmptyReason,
	}),
	Schema.TaggedStruct("RolledBack", {
		stageId: StageId,
		campId: CampTargetId,
		freightDigest: FreightDigest,
		flowKind: DeliveryFlowKind,
		flowTarget: DeliveryFlowTarget,
		rollbackRevision: Schema.NullOr(RevisionRef),
		reason: NonEmptyReason,
	}),
	Schema.TaggedStruct("Failed", {
		stageId: Schema.NullOr(StageId),
		freightDigest: Schema.NullOr(FreightDigest),
		reason: NonEmptyReason,
	}),
]);
export type CdDeliveryRunStatusState = typeof CdDeliveryRunStatusState.Type;

export class CdDeliveryRunStatusView extends Domain.View(
	"CdDeliveryRunStatusView",
	{
		from: [CdDeliveryRun],
		key: CdDeliveryRun,
		state: CdDeliveryRunStatusState,
		initial: { _tag: "Idle" },
		evolve: {
			DeliveryRunStarted: (_state, event) =>
				event.requiresApproval
					? {
							_tag: "PendingApproval" as const,
							stageId: event.stageId,
							campId: event.campId,
							freightDigest: event.freightDigest,
							flowKind: event.flowKind,
							flowTarget: event.flowTarget,
						}
					: {
							_tag: "Publishing" as const,
							stageId: event.stageId,
							campId: event.campId,
							freightDigest: event.freightDigest,
							flowKind: event.flowKind,
							flowTarget: event.flowTarget,
							approver: null,
						},
			DeliveryRunApproved: (_state, event) => ({
				_tag: "Publishing" as const,
				stageId: event.stageId,
				campId: event.campId,
				freightDigest: event.freightDigest,
				flowKind: event.flowKind,
				flowTarget: event.flowTarget,
				approver: event.approver,
			}),
			DeliveryRevisionCommitted: (state, event) =>
				state._tag === "Publishing"
					? {
							_tag: "AwaitingConvergence" as const,
							stageId: state.stageId,
							campId: state.campId,
							freightDigest: state.freightDigest,
							flowKind: state.flowKind,
							flowTarget: state.flowTarget,
							targetRevision: event.revision,
							prId: null,
						}
					: state,
			DeliveryPullRequestOpened: (state, event) =>
				state._tag === "Publishing"
					? {
							_tag: "AwaitingPullRequest" as const,
							stageId: state.stageId,
							campId: state.campId,
							freightDigest: state.freightDigest,
							flowKind: state.flowKind,
							flowTarget: state.flowTarget,
							prId: event.prId,
							prUrl: event.prUrl,
							headBranch: event.headBranch,
						}
					: state,
			DeliveryPullRequestMerged: (state, event) =>
				state._tag === "AwaitingPullRequest"
					? {
							_tag: "AwaitingConvergence" as const,
							stageId: state.stageId,
							campId: state.campId,
							freightDigest: state.freightDigest,
							flowKind: state.flowKind,
							flowTarget: state.flowTarget,
							targetRevision: event.mergeRevision,
							prId: event.prId,
						}
					: state,
			DeliveryConvergenceObserved: (state, event) =>
				state._tag === "AwaitingConvergence"
					? {
							_tag: "Verifying" as const,
							stageId: state.stageId,
							campId: state.campId,
							freightDigest: state.freightDigest,
							flowKind: state.flowKind,
							flowTarget: state.flowTarget,
							appliedRevision: event.appliedRevision,
							prId: state.prId,
						}
					: state,
			DeliveryRunVerified: (state) => state,
			DeliveryRunCompleted: (state, event) =>
				state._tag === "Verifying"
					? {
							_tag: "Completed" as const,
							stageId: state.stageId,
							campId: state.campId,
							freightDigest: state.freightDigest,
							flowKind: state.flowKind,
							flowTarget: state.flowTarget,
							appliedRevision: event.appliedRevision,
							qualifiedAtMs: event.qualifiedAtMs,
							summary: event.summary,
						}
					: state,
			DeliveryRunRolledBack: (state, event) =>
				state._tag === "AwaitingConvergence" || state._tag === "Verifying"
					? {
							_tag: "RolledBack" as const,
							stageId: state.stageId,
							campId: state.campId,
							freightDigest: state.freightDigest,
							flowKind: state.flowKind,
							flowTarget: state.flowTarget,
							rollbackRevision: event.rollbackRevision,
							reason: event.reason,
						}
					: state,
			DeliveryRunFailed: (_state, event) => ({
				_tag: "Failed" as const,
				stageId: event.stageId,
				freightDigest: event.freightDigest,
				reason: event.reason,
			}),
		},
	},
) {}

export class CdRelease extends Domain.Model(
	"CdRelease",
	{
		aggregates: [CdPromotion, CdFanout, CdFreight, CdStage, CdDeliveryRun],
		views: [
			CdPromotionStatusView,
			CdFanoutStatusView,
			CdFreightCatalogView,
			CdStageStatusView,
			CdDeliveryRunStatusView,
		],
		policies: [
			StartCdPromotionPolicy,
			StagePromotionToDeliveryRunPolicy,
			StartCdDeliveryFlowPolicy,
		],
		sagas: [ExecuteCdPromotion, ExecuteCdDeliveryFlow],
	},
	{
		description:
			"Continuous delivery Freight lineage, Stage promotion graph, pluggable pull-based delivery flows, verification, fail-closed rollback compensation, and wave fanout model.",
	},
) {}

export class CdReleaseApi extends Domain.Api(
	"CdReleaseApi",
	{
		model: CdRelease,
		commands: [
			"RequestCdPromotion",
			"ApproveCdPromotion",
			"StartCdFanout",
			"RecordFanoutCampOutcome",
			"RecordFreight",
			"SetFreightAlias",
			"ApproveFreightForStage",
			"YankFreight",
			"ConfigureCdStage",
			"RequestStagePromotion",
			"ReverifyStageFreight",
			"AbortStageVerification",
			"StartDeliveryRun",
			"ApproveDeliveryRun",
		],
		views: [
			"CdPromotionStatusView",
			"CdFanoutStatusView",
			"CdFreightCatalogView",
			"CdStageStatusView",
			"CdDeliveryRunStatusView",
		],
	},
	{
		description:
			"Control API for HoBo CD Freight, Stage lineage, pluggable pull-based delivery runs, promotions, and multi-camp wave fanout.",
	},
) {}

export const CdReleaseHandlers = Layer.mergeAll(
	StartCdPromotionPolicyLive,
	StagePromotionToDeliveryRunPolicyLive,
	StartCdDeliveryFlowPolicyLive,
	ExecuteCdPromotionLive,
	ExecuteCdDeliveryFlowLive,
);
