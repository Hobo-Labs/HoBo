import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
	AutoPromotionPolicy,
	AvailabilityStrategy,
	CampTargetId,
	DEFAULT_ORIGIN_SLOT,
	DeliveryFlowKind,
	DeliveryFlowTarget,
	DeliveryRunId,
	EpochMs,
	FreightDigest,
	NonEmptyReason,
	NonNegativeCount,
	OriginSlotId,
	PositiveCount,
	PromotionTrigger,
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

export const OriginSlotConfig = Schema.Struct({
	slotId: OriginSlotId,
	warehouseId: Schema.NullOr(WarehouseId),
	upstreamStages: UniqueStageList,
	availabilityStrategy: AvailabilityStrategy,
	quorumCount: Schema.NullOr(PositiveCount),
	requiredSoakMs: NonNegativeCount,
	autoPromotion: AutoPromotionPolicy,
});
export type OriginSlotConfig = typeof OriginSlotConfig.Type;

export const OriginSlotStatus = Schema.Struct({
	slotId: OriginSlotId,
	currentFreightDigest: Schema.NullOr(FreightDigest),
	autoPromotionHeld: Schema.Boolean,
	heldFreightDigest: Schema.NullOr(FreightDigest),
	lastVerifiedAtMs: Schema.NullOr(EpochMs),
});
export type OriginSlotStatus = typeof OriginSlotStatus.Type;

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
	originSlots: Schema.optional(Schema.Array(OriginSlotConfig)),
});
export type CdStageConfig = typeof CdStageConfig.Type;

export const QueuedStagePromotion = Schema.Struct({
	deliveryRunId: DeliveryRunId,
	freightDigest: FreightDigest,
	requestedAtMs: EpochMs,
	originSlot: Schema.optional(OriginSlotId),
	trigger: Schema.optional(PromotionTrigger),
	isLatestCandidate: Schema.optional(Schema.Boolean),
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

export class UnknownOriginSlot extends Domain.Rejection("UnknownOriginSlot", {
	originSlot: OriginSlotId,
}) {}

export class AutoPromotionHeld extends Domain.Rejection("AutoPromotionHeld", {
	originSlot: OriginSlotId,
	heldFreightDigest: Schema.NullOr(FreightDigest),
	reason: NonEmptyReason,
}) {}

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
		originSlot: Schema.optional(OriginSlotId),
		trigger: Schema.optional(PromotionTrigger),
		isLatestCandidate: Schema.optional(Schema.Boolean),
	},
) {}

export class StagePromotionQueued extends Domain.Event("StagePromotionQueued", {
	deliveryRunId: DeliveryRunId,
	freightDigest: FreightDigest,
	requestedAtMs: EpochMs,
	originSlot: Schema.optional(OriginSlotId),
	trigger: Schema.optional(PromotionTrigger),
	isLatestCandidate: Schema.optional(Schema.Boolean),
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
		originSlot: Schema.optional(OriginSlotId),
	},
) {}

export class StageAutoPromotionHoldSet extends Domain.Event(
	"StageAutoPromotionHoldSet",
	{
		originSlot: OriginSlotId,
		freightDigest: FreightDigest,
		deliveryRunId: DeliveryRunId,
	},
) {}

export class StageAutoPromotionHoldCleared extends Domain.Event(
	"StageAutoPromotionHoldCleared",
	{
		originSlot: OriginSlotId,
		deliveryRunId: Schema.NullOr(DeliveryRunId),
		reason: NonEmptyReason,
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
		events: [CdStageConfigured, StageAutoPromotionHoldCleared],
		rejects: [InvalidStageConfiguration],
	},
	{
		description:
			"Configure a CD Stage node with lineage strategy, multi-origin slots, soak duration, auto-promotion policy, and pluggable delivery flow.",
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
			originSlot: Schema.optional(OriginSlotId),
			trigger: Schema.optional(PromotionTrigger),
			isLatestCandidate: Schema.optional(Schema.Boolean),
		},
		events: [
			StagePromotionStarted,
			StagePromotionQueued,
			StagePromotionSuperseded,
		],
		rejects: [
			StageNotConfigured,
			UnknownOriginSlot,
			AutoPromotionHeld,
			FreightNotEligibleForStage,
			SoakTimeNotElapsed,
		],
	},
	{
		description:
			"Admit eligible Freight to a Stage origin slot under lineage, soak, auto-promotion hold, or manual approval, queueing or superseding when active.",
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
		events: [
			StagePromotionCompleted,
			StageAutoPromotionHoldSet,
			StageAutoPromotionHoldCleared,
			StagePromotionStarted,
		],
		rejects: [StageNotConfigured, StageRunMismatch],
	},
	{
		description:
			"Mark the active Stage promotion complete, update Kargo auto-promotion holds for the origin slot, and start queued Freight if pending.",
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
			"Record failure of the active Stage promotion without altering auto-promotion holds and advance queued Freight if pending.",
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
		slots: Schema.Array(OriginSlotStatus),
	}),
	Schema.TaggedStruct("Promoting", {
		config: CdStageConfig,
		activeRunId: DeliveryRunId,
		activeFreightDigest: FreightDigest,
		activeOriginSlot: OriginSlotId,
		activeTrigger: PromotionTrigger,
		activeIsLatestCandidate: Schema.Boolean,
		currentFreightDigest: Schema.NullOr(FreightDigest),
		currentRevision: Schema.NullOr(RevisionRef),
		currentVerified: Schema.Boolean,
		lastVerifiedAtMs: Schema.NullOr(EpochMs),
		slots: Schema.Array(OriginSlotStatus),
		pending: Schema.NullOr(QueuedStagePromotion),
	}),
	Schema.TaggedStruct("Verifying", {
		config: CdStageConfig,
		activeRunId: DeliveryRunId,
		activeFreightDigest: FreightDigest,
		activeOriginSlot: OriginSlotId,
		activeTrigger: PromotionTrigger,
		activeIsLatestCandidate: Schema.Boolean,
		currentFreightDigest: Schema.NullOr(FreightDigest),
		currentRevision: Schema.NullOr(RevisionRef),
		currentVerified: Schema.Boolean,
		lastVerifiedAtMs: Schema.NullOr(EpochMs),
		slots: Schema.Array(OriginSlotStatus),
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

function defaultSlotConfigFrom(config: CdStageConfig): OriginSlotConfig {
	return {
		slotId: DEFAULT_ORIGIN_SLOT,
		warehouseId: config.warehouseId,
		upstreamStages: config.upstreamStages,
		availabilityStrategy: config.availabilityStrategy,
		quorumCount: config.quorumCount,
		requiredSoakMs: config.requiredSoakMs,
		autoPromotion: config.autoPromotion,
	};
}

export function effectiveOriginSlots(
	config: CdStageConfig,
): readonly OriginSlotConfig[] {
	if (config.originSlots !== undefined && config.originSlots.length > 0) {
		return config.originSlots;
	}
	return [defaultSlotConfigFrom(config)];
}

function resolveSlotConfig(
	config: CdStageConfig,
	originSlot: OriginSlotId,
): OriginSlotConfig | null {
	for (const slot of effectiveOriginSlots(config)) {
		if (slot.slotId === originSlot) return slot;
	}
	return null;
}

function findSlotStatus(
	slots: readonly OriginSlotStatus[],
	originSlot: OriginSlotId,
): OriginSlotStatus | undefined {
	return slots.find((slot) => slot.slotId === originSlot);
}

function syncSlotsForConfig(
	config: CdStageConfig,
	existing: readonly OriginSlotStatus[],
): OriginSlotStatus[] {
	const byId = new Map<OriginSlotId, OriginSlotStatus>();
	for (const slot of existing) {
		byId.set(slot.slotId, slot);
	}
	return effectiveOriginSlots(config).map((slotConfig) => {
		const prev = byId.get(slotConfig.slotId);
		if (prev === undefined) {
			return {
				slotId: slotConfig.slotId,
				currentFreightDigest: null,
				autoPromotionHeld: false,
				heldFreightDigest: null,
				lastVerifiedAtMs: null,
			};
		}
		if (slotConfig.autoPromotion === "manual" && prev.autoPromotionHeld) {
			return {
				...prev,
				autoPromotionHeld: false,
				heldFreightDigest: null,
			};
		}
		return prev;
	});
}

function updateSlotStatus(
	slots: readonly OriginSlotStatus[],
	originSlot: OriginSlotId,
	update: (current: OriginSlotStatus) => OriginSlotStatus,
): OriginSlotStatus[] {
	let matched = false;
	const next = slots.map((slot) => {
		if (slot.slotId !== originSlot) return slot;
		matched = true;
		return update(slot);
	});
	if (matched) return next;
	return [
		...next,
		update({
			slotId: originSlot,
			currentFreightDigest: null,
			autoPromotionHeld: false,
			heldFreightDigest: null,
			lastVerifiedAtMs: null,
		}),
	];
}

function validateSlotStrategy(slot: {
	readonly warehouseId: WarehouseId | null;
	readonly upstreamStages: readonly StageId[];
	readonly availabilityStrategy: AvailabilityStrategy;
	readonly quorumCount: PositiveCount | null;
}): NonEmptyReason | null {
	if (slot.availabilityStrategy === "direct") {
		if (slot.warehouseId === null) {
			return NonEmptyReason.make("direct-stage-requires-warehouse-id");
		}
		if (slot.quorumCount !== null) {
			return NonEmptyReason.make("direct-stage-forbids-quorum-count");
		}
		return null;
	}
	if (slot.upstreamStages.length === 0) {
		return NonEmptyReason.make(
			"upstream-availability-requires-upstream-stages",
		);
	}
	if (slot.availabilityStrategy === "quorum") {
		if (slot.quorumCount === null) {
			return NonEmptyReason.make("quorum-strategy-requires-quorum-count");
		}
		if (slot.quorumCount > slot.upstreamStages.length) {
			return NonEmptyReason.make("quorum-count-exceeds-upstream-stage-count");
		}
		return null;
	}
	if (slot.quorumCount !== null) {
		return NonEmptyReason.make("quorum-count-only-valid-for-quorum-strategy");
	}
	return null;
}

function validateStageConfig(config: CdStageConfig): NonEmptyReason | null {
	const baseReason = validateSlotStrategy(config);
	if (baseReason !== null) return baseReason;
	if (config.originSlots === undefined || config.originSlots.length === 0) {
		return null;
	}
	const seen = new Set<OriginSlotId>();
	for (const slot of config.originSlots) {
		if (seen.has(slot.slotId)) {
			return NonEmptyReason.make(`duplicate-origin-slot:${slot.slotId}`);
		}
		seen.add(slot.slotId);
		const slotReason = validateSlotStrategy(slot);
		if (slotReason !== null) return slotReason;
	}
	return null;
}

type EligibilityCheck =
	| { readonly _tag: "Eligible" }
	| { readonly _tag: "SoakPending"; readonly earliestEligibleAtMs: EpochMs }
	| { readonly _tag: "Ineligible"; readonly reason: NonEmptyReason };

function evaluateEligibility(
	slot: OriginSlotConfig,
	nowMs: EpochMs,
	upstreamQualifications: readonly UpstreamQualificationEvidence[],
	manualApprovalExpiresAtMs: EpochMs | null,
): EligibilityCheck {
	if (manualApprovalExpiresAtMs !== null && manualApprovalExpiresAtMs > nowMs) {
		return { _tag: "Eligible" };
	}
	if (slot.availabilityStrategy === "direct") {
		return { _tag: "Eligible" };
	}

	const earliestByUpstream = new Map<StageId, number>();
	const allowed = new Set<StageId>(slot.upstreamStages);
	for (const entry of upstreamQualifications) {
		if (!allowed.has(entry.stageId)) continue;
		const readyAt = entry.qualifiedAtMs + slot.requiredSoakMs;
		const existing = earliestByUpstream.get(entry.stageId);
		if (existing === undefined || readyAt < existing) {
			earliestByUpstream.set(entry.stageId, readyAt);
		}
	}

	const requiredCount =
		slot.availabilityStrategy === "one-of"
			? 1
			: slot.availabilityStrategy === "all"
				? slot.upstreamStages.length
				: (slot.quorumCount ?? slot.upstreamStages.length);

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

interface StagePromotionStartedFields {
	deliveryRunId: DeliveryRunId;
	freightDigest: FreightDigest;
	previousFreightDigest: FreightDigest | null;
	previousRevision: RevisionRef | null;
	campId: CampTargetId;
	deliveryFlow: DeliveryFlowKind;
	flowTarget: DeliveryFlowTarget;
	requiresApproval: boolean;
	implicitHealthVerification: boolean;
	triggerPullSync: boolean;
	requestedAtMs: EpochMs;
	originSlot?: OriginSlotId;
	trigger?: PromotionTrigger;
	isLatestCandidate?: boolean;
}

interface StagePromotionQueuedFields {
	deliveryRunId: DeliveryRunId;
	freightDigest: FreightDigest;
	requestedAtMs: EpochMs;
	originSlot?: OriginSlotId;
	trigger?: PromotionTrigger;
	isLatestCandidate?: boolean;
}

interface StagePromotionCompletedFields {
	deliveryRunId: DeliveryRunId;
	freightDigest: FreightDigest;
	appliedRevision: RevisionRef | null;
	qualifiedAtMs: EpochMs;
	summary: NonEmptyReason;
	originSlot?: OriginSlotId;
}

function buildPromotionStartEvent(
	config: CdStageConfig,
	deliveryRunId: DeliveryRunId,
	freightDigest: FreightDigest,
	previousFreightDigest: FreightDigest | null,
	previousRevision: RevisionRef | null,
	requestedAtMs: EpochMs,
	originSlot: OriginSlotId,
	trigger: PromotionTrigger,
	isLatestCandidate: boolean,
): StagePromotionStarted {
	const fields: StagePromotionStartedFields = {
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
	};
	if (originSlot !== DEFAULT_ORIGIN_SLOT) fields.originSlot = originSlot;
	if (trigger !== "manual") fields.trigger = trigger;
	if (!isLatestCandidate) fields.isLatestCandidate = isLatestCandidate;
	return new StagePromotionStarted(fields);
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
		ConfigureCdStage: (state, cmd) => {
			const errorReason = validateStageConfig(cmd.config);
			if (errorReason !== null) {
				return new InvalidStageConfiguration({ reason: errorReason });
			}
			const events: Array<CdStageConfigured | StageAutoPromotionHoldCleared> = [
				new CdStageConfigured({ config: cmd.config }),
			];
			if (state._tag !== "Unconfigured") {
				const nextConfigs = new Map<OriginSlotId, OriginSlotConfig>();
				for (const slotConfig of effectiveOriginSlots(cmd.config)) {
					nextConfigs.set(slotConfig.slotId, slotConfig);
				}
				for (const prevSlot of state.slots) {
					if (!prevSlot.autoPromotionHeld) continue;
					const nextConfig = nextConfigs.get(prevSlot.slotId);
					if (nextConfig === undefined || nextConfig.autoPromotion === "manual") {
						events.push(
							new StageAutoPromotionHoldCleared({
								originSlot: prevSlot.slotId,
								deliveryRunId: null,
								reason: NonEmptyReason.make("auto-promotion-disabled"),
							}),
						);
					}
				}
			}
			return events;
		},
		RequestStagePromotion: (state, cmd) => {
			if (state._tag === "Unconfigured") {
				return new StageNotConfigured({});
			}
			const originSlot = cmd.originSlot ?? DEFAULT_ORIGIN_SLOT;
			const trigger: PromotionTrigger = cmd.trigger ?? "manual";
			const isLatestCandidate = cmd.isLatestCandidate ?? true;
			const slotConfig = resolveSlotConfig(state.config, originSlot);
			if (slotConfig === null) {
				return new UnknownOriginSlot({ originSlot });
			}
			if (trigger === "auto") {
				if (slotConfig.autoPromotion === "manual") {
					return new AutoPromotionHeld({
						originSlot,
						heldFreightDigest: null,
						reason: NonEmptyReason.make("auto-promotion-disabled-for-slot"),
					});
				}
				const slotStatus = findSlotStatus(state.slots, originSlot);
				if (slotStatus?.autoPromotionHeld) {
					return new AutoPromotionHeld({
						originSlot,
						heldFreightDigest: slotStatus.heldFreightDigest,
						reason: NonEmptyReason.make("auto-promotion-held-by-manual-pin"),
					});
				}
			}
			const check = evaluateEligibility(
				slotConfig,
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
				const slotCurrent =
					findSlotStatus(state.slots, originSlot)?.currentFreightDigest ??
					state.currentFreightDigest;
				return [
					buildPromotionStartEvent(
						state.config,
						cmd.deliveryRunId,
						cmd.freightDigest,
						slotCurrent,
						state.currentRevision,
						cmd.nowMs,
						originSlot,
						trigger,
						isLatestCandidate,
					),
				];
			}
			const queuedFields: StagePromotionQueuedFields = {
				deliveryRunId: cmd.deliveryRunId,
				freightDigest: cmd.freightDigest,
				requestedAtMs: cmd.nowMs,
			};
			if (originSlot !== DEFAULT_ORIGIN_SLOT) {
				queuedFields.originSlot = originSlot;
			}
			if (trigger !== "manual") queuedFields.trigger = trigger;
			if (!isLatestCandidate) {
				queuedFields.isLatestCandidate = isLatestCandidate;
			}
			const queued = new StagePromotionQueued(queuedFields);
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
			const completedFields: StagePromotionCompletedFields = {
				deliveryRunId: state.activeRunId,
				freightDigest: state.activeFreightDigest,
				appliedRevision: cmd.appliedRevision,
				qualifiedAtMs: cmd.qualifiedAtMs,
				summary: cmd.summary,
			};
			if (state.activeOriginSlot !== DEFAULT_ORIGIN_SLOT) {
				completedFields.originSlot = state.activeOriginSlot;
			}
			const events: Array<
				| StagePromotionCompleted
				| StageAutoPromotionHoldSet
				| StageAutoPromotionHoldCleared
				| StagePromotionStarted
			> = [new StagePromotionCompleted(completedFields)];
			const slotConfig = resolveSlotConfig(
				state.config,
				state.activeOriginSlot,
			);
			const slotStatus = findSlotStatus(state.slots, state.activeOriginSlot);
			if (
				state.activeTrigger === "manual" &&
				!state.activeIsLatestCandidate &&
				slotConfig !== null &&
				slotConfig.autoPromotion !== "manual"
			) {
				events.push(
					new StageAutoPromotionHoldSet({
						originSlot: state.activeOriginSlot,
						freightDigest: state.activeFreightDigest,
						deliveryRunId: state.activeRunId,
					}),
				);
			} else if (
				state.activeTrigger === "manual" &&
				state.activeIsLatestCandidate &&
				slotStatus?.autoPromotionHeld
			) {
				events.push(
					new StageAutoPromotionHoldCleared({
						originSlot: state.activeOriginSlot,
						deliveryRunId: state.activeRunId,
						reason: NonEmptyReason.make("latest-candidate-manually-promoted"),
					}),
				);
			}
			const nextRevision = cmd.appliedRevision ?? state.currentRevision;
			if (state.pending !== null) {
				events.push(
					buildPromotionStartEvent(
						state.config,
						state.pending.deliveryRunId,
						state.pending.freightDigest,
						state.activeFreightDigest,
						nextRevision,
						state.pending.requestedAtMs,
						state.pending.originSlot ?? DEFAULT_ORIGIN_SLOT,
						state.pending.trigger ?? "manual",
						state.pending.isLatestCandidate ?? true,
					),
				);
			}
			return events;
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
						state.pending.originSlot ?? DEFAULT_ORIGIN_SLOT,
						state.pending.trigger ?? "manual",
						state.pending.isLatestCandidate ?? true,
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
						state.pending.originSlot ?? DEFAULT_ORIGIN_SLOT,
						state.pending.trigger ?? "manual",
						state.pending.isLatestCandidate ?? true,
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
						slots: syncSlotsForConfig(event.config, []),
					}
				: {
						...state,
						config: event.config,
						slots: syncSlotsForConfig(event.config, state.slots),
					},
		StagePromotionStarted: (state, event) =>
			state._tag === "Unconfigured"
				? state
				: {
						_tag: "Promoting" as const,
						config: state.config,
						activeRunId: event.deliveryRunId,
						activeFreightDigest: event.freightDigest,
						activeOriginSlot: event.originSlot ?? DEFAULT_ORIGIN_SLOT,
						activeTrigger: event.trigger ?? "manual",
						activeIsLatestCandidate: event.isLatestCandidate ?? true,
						currentFreightDigest: state.currentFreightDigest,
						currentRevision: state.currentRevision,
						currentVerified: state.currentVerified,
						lastVerifiedAtMs: state.lastVerifiedAtMs,
						slots: state.slots,
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
							originSlot: event.originSlot ?? DEFAULT_ORIGIN_SLOT,
							trigger: event.trigger ?? "manual",
							isLatestCandidate: event.isLatestCandidate ?? true,
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
						activeOriginSlot: state.activeOriginSlot,
						activeTrigger: state.activeTrigger,
						activeIsLatestCandidate: state.activeIsLatestCandidate,
						currentFreightDigest: state.currentFreightDigest,
						currentRevision: state.currentRevision,
						currentVerified: state.currentVerified,
						lastVerifiedAtMs: state.lastVerifiedAtMs,
						slots: state.slots,
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
						slots: updateSlotStatus(
							state.slots,
							event.originSlot ?? state.activeOriginSlot,
							(slot) => ({
								...slot,
								currentFreightDigest: event.freightDigest,
								lastVerifiedAtMs: event.qualifiedAtMs,
							}),
						),
					}
				: state,
		StageAutoPromotionHoldSet: (state, event) =>
			state._tag === "Unconfigured"
				? state
				: {
						...state,
						slots: updateSlotStatus(state.slots, event.originSlot, (slot) => ({
							...slot,
							autoPromotionHeld: true,
							heldFreightDigest: event.freightDigest,
						})),
					},
		StageAutoPromotionHoldCleared: (state, event) =>
			state._tag === "Unconfigured"
				? state
				: {
						...state,
						slots: updateSlotStatus(state.slots, event.originSlot, (slot) => ({
							...slot,
							autoPromotionHeld: false,
							heldFreightDigest: null,
						})),
					},
		StagePromotionFailed: (state) =>
			state._tag === "Promoting" || state._tag === "Verifying"
				? {
						_tag: "Idle" as const,
						config: state.config,
						currentFreightDigest: state.currentFreightDigest,
						currentRevision: state.currentRevision,
						currentVerified: state.currentVerified,
						lastVerifiedAtMs: state.lastVerifiedAtMs,
						slots: state.slots,
					}
				: state,
		StageReverificationStarted: (state, event) =>
			state._tag === "Idle"
				? {
						_tag: "Verifying" as const,
						config: state.config,
						activeRunId: event.deliveryRunId,
						activeFreightDigest: event.freightDigest,
						activeOriginSlot: DEFAULT_ORIGIN_SLOT,
						activeTrigger: "manual" as const,
						activeIsLatestCandidate: true,
						currentFreightDigest: state.currentFreightDigest,
						currentRevision: state.currentRevision,
						currentVerified: state.currentVerified,
						lastVerifiedAtMs: state.lastVerifiedAtMs,
						slots: state.slots,
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
						slots: state.slots,
					}
				: state,
	},
}) {}
