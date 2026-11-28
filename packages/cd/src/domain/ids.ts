import * as Schema from "effect/Schema";

export const CdPromotionId = Schema.NonEmptyString.pipe(
	Schema.brand("CdPromotionId"),
);
export type CdPromotionId = typeof CdPromotionId.Type;

export const CdFanoutId = Schema.NonEmptyString.pipe(
	Schema.brand("CdFanoutId"),
);
export type CdFanoutId = typeof CdFanoutId.Type;

export const CampTargetId = Schema.NonEmptyString.pipe(
	Schema.brand("CampTargetId"),
);
export type CampTargetId = typeof CampTargetId.Type;

export const FreightDigest = Schema.NonEmptyString.check(
	Schema.isPattern(/^sha256:.+$/u),
).pipe(Schema.brand("FreightDigest"));
export type FreightDigest = typeof FreightDigest.Type;

export const WarehouseId = Schema.NonEmptyString.pipe(
	Schema.brand("WarehouseId"),
);
export type WarehouseId = typeof WarehouseId.Type;

export const FreightAlias = Schema.NonEmptyString.check(
	Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/u),
).pipe(Schema.brand("FreightAlias"));
export type FreightAlias = typeof FreightAlias.Type;

export const StageId = Schema.NonEmptyString.pipe(Schema.brand("StageId"));
export type StageId = typeof StageId.Type;

export const OriginSlotId = Schema.NonEmptyString.check(
	Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/u),
).pipe(Schema.brand("OriginSlotId"));
export type OriginSlotId = typeof OriginSlotId.Type;

export const DEFAULT_ORIGIN_SLOT: OriginSlotId = OriginSlotId.make("default");

export const PromotionTrigger = Schema.Literals(["manual", "auto"]);
export type PromotionTrigger = typeof PromotionTrigger.Type;

export const DeliveryRunId = Schema.NonEmptyString.pipe(
	Schema.brand("DeliveryRunId"),
);
export type DeliveryRunId = typeof DeliveryRunId.Type;

export const RevisionRef = Schema.NonEmptyString.pipe(
	Schema.brand("RevisionRef"),
);
export type RevisionRef = typeof RevisionRef.Type;

export const PullRequestId = Schema.NonEmptyString.pipe(
	Schema.brand("PullRequestId"),
);
export type PullRequestId = typeof PullRequestId.Type;

export const PullRequestUrl = Schema.NonEmptyString.check(
	Schema.isPattern(/^https:\/\/.+$/u),
).pipe(Schema.brand("PullRequestUrl"));
export type PullRequestUrl = typeof PullRequestUrl.Type;

export const BranchName = Schema.NonEmptyString.pipe(
	Schema.brand("BranchName"),
);
export type BranchName = typeof BranchName.Type;

export const DeliveryFlowTarget = Schema.NonEmptyString.check(
	Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/u),
).pipe(Schema.brand("DeliveryFlowTarget"));
export type DeliveryFlowTarget = typeof DeliveryFlowTarget.Type;

export const ApproverId = Schema.NonEmptyString.pipe(
	Schema.brand("ApproverId"),
);
export type ApproverId = typeof ApproverId.Type;

export const RealizationRef = Schema.NonEmptyString.pipe(
	Schema.brand("RealizationRef"),
);
export type RealizationRef = typeof RealizationRef.Type;

export const NonEmptyReason = Schema.NonEmptyString.pipe(
	Schema.brand("NonEmptyReason"),
);
export type NonEmptyReason = typeof NonEmptyReason.Type;

export const NonNegativeCount = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("NonNegativeCount"));
export type NonNegativeCount = typeof NonNegativeCount.Type;

export const PositiveCount = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(1),
).pipe(Schema.brand("PositiveCount"));
export type PositiveCount = typeof PositiveCount.Type;

export const EpochMs = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
	Schema.brand("EpochMs"),
);
export type EpochMs = typeof EpochMs.Type;

export const UniqueCampWave = Schema.NonEmptyArray(CampTargetId)
	.check(
		Schema.makeFilter(
			(items: readonly CampTargetId[]) => new Set(items).size === items.length,
			{ title: "UniqueCampWave" },
		),
	)
	.pipe(Schema.brand("UniqueCampWave"));
export type UniqueCampWave = typeof UniqueCampWave.Type;

export const UniqueStageList = Schema.Array(StageId)
	.check(
		Schema.makeFilter(
			(items: readonly StageId[]) => new Set(items).size === items.length,
			{ title: "UniqueStageList" },
		),
	)
	.pipe(Schema.brand("UniqueStageList"));
export type UniqueStageList = typeof UniqueStageList.Type;

export const ArtifactKindTag = Schema.Literals([
	"oci-image",
	"git-commit",
	"chart",
	"package",
	"bindle-config",
]);
export type ArtifactKindTag = typeof ArtifactKindTag.Type;

export const FreightArtifactRef = Schema.Struct({
	kind: ArtifactKindTag,
	repository: Schema.NonEmptyString,
	reference: Schema.NonEmptyString,
	digest: FreightDigest,
});
export type FreightArtifactRef = typeof FreightArtifactRef.Type;

export const AvailabilityStrategy = Schema.Literals([
	"direct",
	"one-of",
	"all",
	"quorum",
]);
export type AvailabilityStrategy = typeof AvailabilityStrategy.Type;

export const AutoPromotionPolicy = Schema.Literals([
	"manual",
	"newest",
	"match-upstream",
]);
export type AutoPromotionPolicy = typeof AutoPromotionPolicy.Type;

export const DeliveryFlowKind = Schema.Literals([
	"gitops-pull",
	"gitops-pr-pull",
	"agent-pull",
	"conductor-direct",
	"release-orchestrator",
]);
export type DeliveryFlowKind = typeof DeliveryFlowKind.Type;

export const StagePhase = Schema.Literals([
	"unconfigured",
	"idle",
	"promoting",
	"verifying",
]);
export type StagePhase = typeof StagePhase.Type;

export const DeliveryRunPhase = Schema.Literals([
	"idle",
	"pending-approval",
	"publishing",
	"awaiting-pr",
	"awaiting-convergence",
	"verifying",
	"completed",
	"rolled-back",
	"failed",
]);
export type DeliveryRunPhase = typeof DeliveryRunPhase.Type;

export const CdPromotionPhase = Schema.Literals([
	"idle",
	"pending-approval",
	"approved",
	"realized",
	"verified",
	"completed",
	"rolled-back",
	"failed",
]);
export type CdPromotionPhase = typeof CdPromotionPhase.Type;

export const CdFanoutPhase = Schema.Literals([
	"idle",
	"running",
	"completed",
	"halted",
]);
export type CdFanoutPhase = typeof CdFanoutPhase.Type;
