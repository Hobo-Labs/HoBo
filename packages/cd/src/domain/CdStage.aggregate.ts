import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
	AutoPromotionPolicy,
	AvailabilityStrategy,
	CampTargetId,
	DeliveryFlowKind,
	DeliveryFlowTarget,
	DeliveryRunId,
	EpochMs,
	FreightDigest,
	NonEmptyReason,
	NonNegativeCount,
	PositiveCount,
	RevisionRef,
	StageId,
	StagePhase,
	UniqueStageList,
	WarehouseId,
} from "./ids.js";

export const UpstreamQualificationEvidence = Schema.Struct({
	stageId: StageId,
	qualifiedAtMs: EpochMs,
});
export type UpstreamQualificationEvidence =
	typeof UpstreamQualificationEvidence.Type;

export const CdStageConfig = Schema.Struct({
	warehouseId: Schema.NullOr(WarehouseId),
	upstreamStages: UniqueStageList,
	availabilityStrategy: AvailabilityStrategy,
	quorumCount: Schema.NullOr(PositiveCount),
	requiredSoakMs: NonNegativeCount,
	autoPromotion: AutoPromotionPolicy,
	deliveryFlow: DeliveryFlowKind,
	flowTarget: DeliveryFlowTarget,
	campId: CampTargetId,
	requiresApproval: Schema.Boolean,
	implicitHealthVerification: Schema.Boolean,
	triggerPullSync: Schema.Boolean,
});
export type CdStageConfig = typeof CdStageConfig.Type;

export const QueuedStagePromotion = Schema.Struct({
	deliveryRunId: DeliveryRunId,
	freightDigest: FreightDigest,
	requestedAtMs: EpochMs,
});
export type QueuedStagePromotion = typeof QueuedStagePromotion.Type;

export class StageNotConfigured extends Domain.Rejection(
	"StageNotConfigured",
	{},
) {}

export class InvalidStageConfiguration extends Domain.Rejection(
	"InvalidStageConfiguration",
	{
		reason: NonEmptyReason,
	},
) {}

export class FreightNotEligibleForStage extends Domain.Rejection(
	"FreightNotEligibleForStage",
	{
		freightDigest: FreightDigest,
		reason: NonEmptyReason,
	},
) {}

export class SoakTimeNotElapsed extends Domain.Rejection("SoakTimeNotElapsed", {
	freightDigest: FreightDigest,
	earliestEligibleAtMs: EpochMs,
	nowMs: EpochMs,
}) {}

export class StageRunMismatch extends Domain.Rejection("StageRunMismatch", {
	expectedRunId: Schema.NullOr(DeliveryRunId),
	actualRunId: DeliveryRunId,
	phase: StagePhase,
}) {}

export class StageBusy extends Domain.Rejection("StageBusy", {
	phase: StagePhase,
	activeRunId: DeliveryRunId,
}) {}

export class NoCurrentFreightToReverify extends Domain.Rejection(
	"NoCurrentFreightToReverify",
	{},
) {}

export class StageNotVerifying extends Domain.Rejection("StageNotVerifying", {
	phase: StagePhase,
}) {}

export class CdStageConfigured extends Domain.Event("CdStageConfigured", {
	config: CdStageConfig,
}) {}

export class StagePromotionStarted extends Domain.Event(
	"StagePromotionStarted",
	{
		deliveryRunId: DeliveryRunId,
		freightDigest: FreightDigest,
		previousFreightDigest: Schema.NullOr(FreightDigest),
		previousRevision: Schema.NullOr(RevisionRef),
		campId: CampTargetId,
		deliveryFlow: DeliveryFlowKind,
		flowTarget: DeliveryFlowTarget,
		requiresApproval: Schema.Boolean,
		implicitHealthVerification: Schema.Boolean,
		triggerPullSync: Schema.Boolean,
		requestedAtMs: EpochMs,
	},
) {}

export class StagePromotionQueued extends Domain.Event("StagePromotionQueued", {
	deliveryRunId: DeliveryRunId,
	freightDigest: FreightDigest,
	requestedAtMs: EpochMs,
}) {}

export class StagePromotionSuperseded extends Domain.Event(
	"StagePromotionSuperseded",
	{
		supersededRunId: DeliveryRunId,
		supersededFreightDigest: FreightDigest,
		replacementRunId: DeliveryRunId,
		replacementFreightDigest: FreightDigest,
	},
) {}

export class StageEnteredVerifying extends Domain.Event(
	"StageEnteredVerifying",
	{
		deliveryRunId: DeliveryRunId,
		freightDigest: FreightDigest,
	},
) {}

export class StagePromotionCompleted extends Domain.Event(
	"StagePromotionCompleted",
	{
		deliveryRunId: DeliveryRunId,
		freightDigest: FreightDigest,
		appliedRevision: Schema.NullOr(RevisionRef),
		qualifiedAtMs: EpochMs,
		summary: NonEmptyReason,
	},
) {}

export class StagePromotionFailed extends Domain.Event("StagePromotionFailed", {
	deliveryRunId: DeliveryRunId,
	freightDigest: FreightDigest,
	reason: NonEmptyReason,
}) {}

export class StageReverificationStarted extends Domain.Event(
	"StageReverificationStarted",
	{
		deliveryRunId: DeliveryRunId,
		freightDigest: FreightDigest,
		campId: CampTargetId,
		flowTarget: DeliveryFlowTarget,
		startedAtMs: EpochMs,
	},
) {}

export class StageVerificationAborted extends Domain.Event(
	"StageVerificationAborted",
	{
		deliveryRunId: DeliveryRunId,
		freightDigest: FreightDigest,
		reason: NonEmptyReason,
	},
) {}

export class ConfigureCdStage extends Domain.Command(
	"ConfigureCdStage",
	{
		target: StageId,
		input: {
			config: CdStageConfig,
		},
		events: [CdStageConfigured],
		rejects: [InvalidStageConfiguration],
	},
	{
		description:
			"Configure a CD Stage node with lineage strategy, soak duration, auto-promotion policy, and pluggable delivery flow.",
	},
) {}

export class RequestStagePromotion extends Domain.Command(
	"RequestStagePromotion",
	{
		target: StageId,
		input: {
			deliveryRunId: DeliveryRunId,
			freightDigest: FreightDigest,
			nowMs: EpochMs,
			upstreamQualifications: Schema.Array(UpstreamQualificationEvidence),
			manualApprovalExpiresAtMs: Schema.NullOr(EpochMs),
		},
		events: [
			StagePromotionStarted,
			StagePromotionQueued,
			StagePromotionSuperseded,
		],
		rejects: [
			StageNotConfigured,
			FreightNotEligibleForStage,
			SoakTimeNotElapsed,
		],
	},
	{
		description:
			"Admit eligible Freight to a Stage under lineage, soak, or manual approval, queueing or superseding when the Stage is active.",
	},
) {}

export class MarkStageVerifying extends Domain.Command(
	"MarkStageVerifying",
	{
		target: StageId,
		input: {
			deliveryRunId: DeliveryRunId,
		},
		events: [StageEnteredVerifying],
		rejects: [StageNotConfigured, StageRunMismatch],
	},
	{
		description:
			"Transition an active Stage promotion into verification so concurrent promotions wait until verification settles.",
	},
) {}

export class CompleteStagePromotion extends Domain.Command(
	"CompleteStagePromotion",
	{
		target: StageId,
		input: {
			deliveryRunId: DeliveryRunId,
			appliedRevision: Schema.NullOr(RevisionRef),
			qualifiedAtMs: EpochMs,
			summary: NonEmptyReason,
		},
		events: [StagePromotionCompleted, StagePromotionStarted],
		rejects: [StageNotConfigured, StageRunMismatch],
	},
	{
		description:
			"Mark the active Stage promotion complete and automatically start queued Freight if pending.",
	},
) {}

export class FailStagePromotion extends Domain.Command(
	"FailStagePromotion",
	{
		target: StageId,
		input: {
			deliveryRunId: DeliveryRunId,
			reason: NonEmptyReason,
		},
		events: [StagePromotionFailed, StagePromotionStarted],
		rejects: [StageNotConfigured, StageRunMismatch],
	},
	{
		description:
			"Record failure of the active Stage promotion and advance queued Freight if pending.",
	},
) {}

export class ReverifyStageFreight extends Domain.Command(
	"ReverifyStageFreight",
	{
		target: StageId,
		input: {
			deliveryRunId: DeliveryRunId,
			nowMs: EpochMs,
		},
		events: [StageReverificationStarted],
		rejects: [StageNotConfigured, StageBusy, NoCurrentFreightToReverify],
	},
	{
		description:
			"Re-run verification against the Stage current Freight without re-deploying.",
	},
) {}

export class AbortStageVerification extends Domain.Command(
	"AbortStageVerification",
	{
		target: StageId,
		input: {
			reason: NonEmptyReason,
		},
		events: [StageVerificationAborted, StagePromotionStarted],
		rejects: [StageNotConfigured, StageNotVerifying],
	},
	{
		description:
			"Abort an ongoing Stage verification and advance queued Freight if pending.",
	},
) {}

export const CdStageState = Schema.Union([
	Schema.TaggedStruct("Unconfigured", {}),
	Schema.TaggedStruct("Idle", {
		config: CdStageConfig,
		currentFreightDigest: Schema.NullOr(FreightDigest),
		currentRevision: Schema.NullOr(RevisionRef),
		currentVerified: Schema.Boolean,
		lastVerifiedAtMs: Schema.NullOr(EpochMs),
	}),
	Schema.TaggedStruct("Promoting", {
		config: CdStageConfig,
		activeRunId: DeliveryRunId,
		activeFreightDigest: FreightDigest,
		currentFreightDigest: Schema.NullOr(FreightDigest),
		currentRevision: Schema.NullOr(RevisionRef),
		currentVerified: Schema.Boolean,
		lastVerifiedAtMs: Schema.NullOr(EpochMs),
		pending: Schema.NullOr(QueuedStagePromotion),
	}),
	Schema.TaggedStruct("Verifying", {
		config: CdStageConfig,
		activeRunId: DeliveryRunId,
		activeFreightDigest: FreightDigest,
		currentFreightDigest: Schema.NullOr(FreightDigest),
		currentRevision: Schema.NullOr(RevisionRef),
		currentVerified: Schema.Boolean,
		lastVerifiedAtMs: Schema.NullOr(EpochMs),
		pending: Schema.NullOr(QueuedStagePromotion),
	}),
]);
export type CdStageState = typeof CdStageState.Type;

function stagePhaseOf(state: CdStageState): StagePhase {
	switch (state._tag) {
		case "Unconfigured":
			return "unconfigured";
		case "Idle":
			return "idle";
		case "Promoting":
			return "promoting";
		case "Verifying":
			return "verifying";
	}
}

function validateStageConfig(config: CdStageConfig): NonEmptyReason | null {
	if (config.availabilityStrategy === "direct") {
		if (config.warehouseId === null) {
			return NonEmptyReason.make("direct-stage-requires-warehouse-id");
		}
		if (config.quorumCount !== null) {
			return NonEmptyReason.make("direct-stage-forbids-quorum-count");
		}
		return null;
	}
	if (config.upstreamStages.length === 0) {
		return NonEmptyReason.make(
			"upstream-availability-requires-upstream-stages",
		);
	}
	if (config.availabilityStrategy === "quorum") {
		if (config.quorumCount === null) {
			return NonEmptyReason.make("quorum-strategy-requires-quorum-count");
		}
		if (config.quorumCount > config.upstreamStages.length) {
			return NonEmptyReason.make("quorum-count-exceeds-upstream-stage-count");
		}
		return null;
	}
	if (config.quorumCount !== null) {
		return NonEmptyReason.make("quorum-count-only-valid-for-quorum-strategy");
	}
	return null;
}

type EligibilityCheck =
	| { readonly _tag: "Eligible" }
	| { readonly _tag: "SoakPending"; readonly earliestEligibleAtMs: EpochMs }
	| { readonly _tag: "Ineligible"; readonly reason: NonEmptyReason };

function evaluateEligibility(
	config: CdStageConfig,
	nowMs: EpochMs,
	upstreamQualifications: readonly UpstreamQualificationEvidence[],
	manualApprovalExpiresAtMs: EpochMs | null,
): EligibilityCheck {
	if (manualApprovalExpiresAtMs !== null && manualApprovalExpiresAtMs > nowMs) {
		return { _tag: "Eligible" };
	}
	if (config.availabilityStrategy === "direct") {
		return { _tag: "Eligible" };
	}

	const earliestByUpstream = new Map<StageId, number>();
	const allowed = new Set<StageId>(config.upstreamStages);
	for (const entry of upstreamQualifications) {
		if (!allowed.has(entry.stageId)) continue;
		const readyAt = entry.qualifiedAtMs + config.requiredSoakMs;
		const existing = earliestByUpstream.get(entry.stageId);
		if (existing === undefined || readyAt < existing) {
			earliestByUpstream.set(entry.stageId, readyAt);
		}
	}

	const requiredCount =
		config.availabilityStrategy === "one-of"
			? 1
			: config.availabilityStrategy === "all"
				? config.upstreamStages.length
				: (config.quorumCount ?? config.upstreamStages.length);

	if (earliestByUpstream.size < requiredCount) {
		return {
			_tag: "Ineligible",
			reason: NonEmptyReason.make(
				`upstream-qualification-insufficient:${earliestByUpstream.size}/${requiredCount}`,
			),
		};
	}

	const sortedReadyTimes = [...earliestByUpstream.values()].sort(
		(a, b) => a - b,
	);
	const thresholdReadyAt = sortedReadyTimes[requiredCount - 1];
	if (thresholdReadyAt === undefined) {
		return {
			_tag: "Ineligible",
			reason: NonEmptyReason.make("upstream-qualification-missing"),
		};
	}
	if (thresholdReadyAt > nowMs) {
		return {
			_tag: "SoakPending",
			earliestEligibleAtMs: EpochMs.make(thresholdReadyAt),
		};
	}
	return { _tag: "Eligible" };
}

function buildPromotionStartEvent(
	config: CdStageConfig,
	deliveryRunId: DeliveryRunId,
	freightDigest: FreightDigest,
	previousFreightDigest: FreightDigest | null,
	previousRevision: RevisionRef | null,
	requestedAtMs: EpochMs,
): StagePromotionStarted {
	return new StagePromotionStarted({
		deliveryRunId,
		freightDigest,
		previousFreightDigest,
		previousRevision,
		campId: config.campId,
		deliveryFlow: config.deliveryFlow,
		flowTarget: config.flowTarget,
		requiresApproval: config.requiresApproval,
		implicitHealthVerification: config.implicitHealthVerification,
		triggerPullSync: config.triggerPullSync,
		requestedAtMs,
	});
}

export class CdStage extends Domain.Aggregate("CdStage", {
	id: StageId,
	state: CdStageState,
	initial: { _tag: "Unconfigured" },
	commands: [
		ConfigureCdStage,
		RequestStagePromotion,
		MarkStageVerifying,
		CompleteStagePromotion,
		FailStagePromotion,
		ReverifyStageFreight,
		AbortStageVerification,
	],
	decide: {
		ConfigureCdStage: (_state, cmd) => {
			const errorReason = validateStageConfig(cmd.config);
			if (errorReason !== null) {
				return new InvalidStageConfiguration({ reason: errorReason });
			}
			return [new CdStageConfigured({ config: cmd.config })];
		},
		RequestStagePromotion: (state, cmd) => {
			if (state._tag === "Unconfigured") {
				return new StageNotConfigured({});
			}
			const check = evaluateEligibility(
				state.config,
				cmd.nowMs,
				cmd.upstreamQualifications,
				cmd.manualApprovalExpiresAtMs,
			);
			if (check._tag === "SoakPending") {
				return new SoakTimeNotElapsed({
					freightDigest: cmd.freightDigest,
					earliestEligibleAtMs: check.earliestEligibleAtMs,
					nowMs: cmd.nowMs,
				});
			}
			if (check._tag === "Ineligible") {
				return new FreightNotEligibleForStage({
					freightDigest: cmd.freightDigest,
					reason: check.reason,
				});
			}
			if (state._tag === "Idle") {
				return [
					buildPromotionStartEvent(
						state.config,
						cmd.deliveryRunId,
						cmd.freightDigest,
						state.currentFreightDigest,
						state.currentRevision,
						cmd.nowMs,
					),
				];
			}
			const queued = new StagePromotionQueued({
				deliveryRunId: cmd.deliveryRunId,
				freightDigest: cmd.freightDigest,
				requestedAtMs: cmd.nowMs,
			});
			if (state.pending !== null) {
				return [
					new StagePromotionSuperseded({
						supersededRunId: state.pending.deliveryRunId,
						supersededFreightDigest: state.pending.freightDigest,
						replacementRunId: cmd.deliveryRunId,
						replacementFreightDigest: cmd.freightDigest,
					}),
					queued,
				];
			}
			return [queued];
		},
		MarkStageVerifying: (state, cmd) => {
			if (state._tag === "Unconfigured") {
				return new StageNotConfigured({});
			}
			if (
				state._tag !== "Promoting" ||
				state.activeRunId !== cmd.deliveryRunId
			) {
				return new StageRunMismatch({
					expectedRunId:
						state._tag === "Promoting" || state._tag === "Verifying"
							? state.activeRunId
							: null,
					actualRunId: cmd.deliveryRunId,
					phase: stagePhaseOf(state),
				});
			}
			return [
				new StageEnteredVerifying({
					deliveryRunId: state.activeRunId,
					freightDigest: state.activeFreightDigest,
				}),
			];
		},
		CompleteStagePromotion: (state, cmd) => {
			if (state._tag === "Unconfigured") {
				return new StageNotConfigured({});
			}
			if (
				(state._tag !== "Promoting" && state._tag !== "Verifying") ||
				state.activeRunId !== cmd.deliveryRunId
			) {
				return new StageRunMismatch({
					expectedRunId:
						state._tag === "Promoting" || state._tag === "Verifying"
							? state.activeRunId
							: null,
					actualRunId: cmd.deliveryRunId,
					phase: stagePhaseOf(state),
				});
			}
			const completed = new StagePromotionCompleted({
				deliveryRunId: state.activeRunId,
				freightDigest: state.activeFreightDigest,
				appliedRevision: cmd.appliedRevision,
				qualifiedAtMs: cmd.qualifiedAtMs,
				summary: cmd.summary,
			});
			const nextRevision = cmd.appliedRevision ?? state.currentRevision;
			if (state.pending !== null) {
				return [
					completed,
					buildPromotionStartEvent(
						state.config,
						state.pending.deliveryRunId,
						state.pending.freightDigest,
						state.activeFreightDigest,
						nextRevision,
						state.pending.requestedAtMs,
					),
				];
			}
			return [completed];
		},
		FailStagePromotion: (state, cmd) => {
			if (state._tag === "Unconfigured") {
				return new StageNotConfigured({});
			}
			if (
				(state._tag !== "Promoting" && state._tag !== "Verifying") ||
				state.activeRunId !== cmd.deliveryRunId
			) {
				return new StageRunMismatch({
					expectedRunId:
						state._tag === "Promoting" || state._tag === "Verifying"
							? state.activeRunId
							: null,
					actualRunId: cmd.deliveryRunId,
					phase: stagePhaseOf(state),
				});
			}
			const failed = new StagePromotionFailed({
				deliveryRunId: state.activeRunId,
				freightDigest: state.activeFreightDigest,
				reason: cmd.reason,
			});
			if (state.pending !== null) {
				return [
					failed,
					buildPromotionStartEvent(
						state.config,
						state.pending.deliveryRunId,
						state.pending.freightDigest,
						state.currentFreightDigest,
						state.currentRevision,
						state.pending.requestedAtMs,
					),
				];
			}
			return [failed];
		},
		ReverifyStageFreight: (state, cmd) => {
			if (state._tag === "Unconfigured") {
				return new StageNotConfigured({});
			}
			if (state._tag !== "Idle") {
				return new StageBusy({
					phase: stagePhaseOf(state),
					activeRunId: state.activeRunId,
				});
			}
			if (state.currentFreightDigest === null) {
				return new NoCurrentFreightToReverify({});
			}
			return [
				new StageReverificationStarted({
					deliveryRunId: cmd.deliveryRunId,
					freightDigest: state.currentFreightDigest,
					campId: state.config.campId,
					flowTarget: state.config.flowTarget,
					startedAtMs: cmd.nowMs,
				}),
			];
		},
		AbortStageVerification: (state, cmd) => {
			if (state._tag === "Unconfigured") {
				return new StageNotConfigured({});
			}
			if (state._tag !== "Verifying") {
				return new StageNotVerifying({ phase: stagePhaseOf(state) });
			}
			const aborted = new StageVerificationAborted({
				deliveryRunId: state.activeRunId,
				freightDigest: state.activeFreightDigest,
				reason: cmd.reason,
			});
			if (state.pending !== null) {
				return [
					aborted,
					buildPromotionStartEvent(
						state.config,
						state.pending.deliveryRunId,
						state.pending.freightDigest,
						state.currentFreightDigest,
						state.currentRevision,
						state.pending.requestedAtMs,
					),
				];
			}
			return [aborted];
		},
	},
	evolve: {
		CdStageConfigured: (state, event) =>
			state._tag === "Unconfigured"
				? {
						_tag: "Idle" as const,
						config: event.config,
						currentFreightDigest: null,
						currentRevision: null,
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
						currentRevision: state.currentRevision,
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
						currentRevision: state.currentRevision,
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
						currentRevision: event.appliedRevision ?? state.currentRevision,
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
						currentRevision: state.currentRevision,
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
						currentRevision: state.currentRevision,
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
						currentRevision: state.currentRevision,
						currentVerified: false,
						lastVerifiedAtMs: state.lastVerifiedAtMs,
					}
				: state,
	},
}) {}
