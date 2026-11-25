import * as Schema from "effect/Schema";

export const TrafficRouteId = Schema.NonEmptyString.pipe(
	Schema.brand("TrafficRouteId"),
);
export type TrafficRouteId = typeof TrafficRouteId.Type;

export const CloudBackendId = Schema.NonEmptyString.pipe(
	Schema.brand("CloudBackendId"),
);
export type CloudBackendId = typeof CloudBackendId.Type;

export const NonEmptyReason = Schema.NonEmptyString.pipe(
	Schema.brand("NonEmptyReason"),
);
export type NonEmptyReason = typeof NonEmptyReason.Type;

export const CloudProviderKind = Schema.Literals([
	"vercel",
	"cloudflare",
	"hostinger",
	"local",
]);
export type CloudProviderKind = typeof CloudProviderKind.Type;

export const CloudBackendTarget = Schema.Struct({
	provider: CloudProviderKind,
	backendId: CloudBackendId,
});
export type CloudBackendTarget = typeof CloudBackendTarget.Type;

export const TtlSeconds = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(5),
).pipe(Schema.brand("TtlSeconds"));
export type TtlSeconds = typeof TtlSeconds.Type;

export const RampWeightPercent = Schema.Int.check(
	Schema.isBetween({ minimum: 0, maximum: 100 }),
).pipe(Schema.brand("RampWeightPercent"));
export type RampWeightPercent = typeof RampWeightPercent.Type;

export const NonNegativeMs = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("NonNegativeMs"));
export type NonNegativeMs = typeof NonNegativeMs.Type;

export const NonNegativeSeconds = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("NonNegativeSeconds"));
export type NonNegativeSeconds = typeof NonNegativeSeconds.Type;

export const EpochMs = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
	Schema.brand("EpochMs"),
);
export type EpochMs = typeof EpochMs.Type;

export const NonNegativeCount = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("NonNegativeCount"));
export type NonNegativeCount = typeof NonNegativeCount.Type;

export const PositiveSwapLimit = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(1),
).pipe(Schema.brand("PositiveSwapLimit"));
export type PositiveSwapLimit = typeof PositiveSwapLimit.Type;

export const StabilityPolicy = Schema.Struct({
	cooldownMs: NonNegativeMs,
	maxSwapsPerWindow: PositiveSwapLimit,
});
export type StabilityPolicy = typeof StabilityPolicy.Type;

export const ProgressiveRampPlan = Schema.NonEmptyArray(RampWeightPercent)
	.check(
		Schema.makeFilter(
			(steps) => {
				for (let index = 1; index < steps.length; index += 1) {
					const previous = steps[index - 1];
					const current = steps[index];
					if (previous === undefined || current === undefined) {
						return false;
					}
					if (current <= previous) {
						return false;
					}
				}
				return steps[steps.length - 1] === 100;
			},
			{
				title: "ProgressiveRampPlan",
				description:
					"Strictly increasing ramp percentages between 0 and 100 ending at 100.",
			},
		),
	)
	.pipe(Schema.brand("ProgressiveRampPlan"));
export type ProgressiveRampPlan = typeof ProgressiveRampPlan.Type;

export const LoweredTtlEvidence = Schema.Struct({
	previousTtlSeconds: TtlSeconds,
	loweredTtlSeconds: TtlSeconds,
	waitedSeconds: NonNegativeSeconds,
})
	.check(
		Schema.makeFilter(
			(ttl) =>
				ttl.loweredTtlSeconds < ttl.previousTtlSeconds &&
				ttl.waitedSeconds >= ttl.previousTtlSeconds,
			{
				title: "LoweredTtlEvidence",
				description:
					"Lowered TTL must be strictly below previous TTL after waiting at least previous TTL seconds.",
			},
		),
	)
	.pipe(Schema.brand("LoweredTtlEvidence"));
export type LoweredTtlEvidence = typeof LoweredTtlEvidence.Type;

export const CutoverPhase = Schema.Literals([
	"Unregistered",
	"Steady",
	"TtlLowering",
	"Ramping",
	"RolledBack",
	"ReconciliationRequired",
]);
export type CutoverPhase = typeof CutoverPhase.Type;

export const CutoverRefusalReason = Schema.Literals([
	"incumbent-not-registered",
	"cutover-already-in-progress",
	"reconciliation-pending",
	"target-matches-incumbent",
	"preconditions-failed",
	"ttl-not-lowered",
	"ramp-not-monotonic",
	"ramp-incomplete",
]);
export type CutoverRefusalReason = typeof CutoverRefusalReason.Type;

export const decodeTtlSeconds = Schema.decodeSync(TtlSeconds);
export const decodeRampWeightPercent = Schema.decodeSync(RampWeightPercent);
export const decodeNonNegativeMs = Schema.decodeSync(NonNegativeMs);
export const decodeNonNegativeSeconds = Schema.decodeSync(NonNegativeSeconds);
export const decodeEpochMs = Schema.decodeSync(EpochMs);
export const decodeNonNegativeCount = Schema.decodeSync(NonNegativeCount);
export const decodePositiveSwapLimit = Schema.decodeSync(PositiveSwapLimit);
export const decodeProgressiveRampPlan = Schema.decodeSync(ProgressiveRampPlan);
export const decodeLoweredTtlEvidence = Schema.decodeSync(LoweredTtlEvidence);
