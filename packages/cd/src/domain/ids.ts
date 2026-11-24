import * as Schema from "effect/Schema";

export const CdPromotionId = Schema.String.pipe(Schema.brand("CdPromotionId"));
export type CdPromotionId = typeof CdPromotionId.Type;

export const CdFanoutId = Schema.String.pipe(Schema.brand("CdFanoutId"));
export type CdFanoutId = typeof CdFanoutId.Type;

export const CampTargetId = Schema.String.pipe(Schema.brand("CampTargetId"));
export type CampTargetId = typeof CampTargetId.Type;

export const FreightDigest = Schema.String.pipe(Schema.brand("FreightDigest"));
export type FreightDigest = typeof FreightDigest.Type;

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
