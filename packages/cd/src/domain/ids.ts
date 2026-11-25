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

export const UniqueCampWave = Schema.NonEmptyArray(CampTargetId)
	.check(
		Schema.makeFilter(
			(items: readonly CampTargetId[]) => new Set(items).size === items.length,
			{ title: "UniqueCampWave" },
		),
	)
	.pipe(Schema.brand("UniqueCampWave"));
export type UniqueCampWave = typeof UniqueCampWave.Type;

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
