import * as Schema from "effect/Schema";

export const StationId = Schema.NonEmptyString.pipe(Schema.brand("StationId"));
export type StationId = typeof StationId.Type;

export const RunnerPoolId = Schema.NonEmptyString.pipe(
	Schema.brand("RunnerPoolId"),
);
export type RunnerPoolId = typeof RunnerPoolId.Type;

export const JobDispatchId = Schema.NonEmptyString.pipe(
	Schema.brand("JobDispatchId"),
);
export type JobDispatchId = typeof JobDispatchId.Type;

export const SlotId = Schema.NonEmptyString.pipe(Schema.brand("SlotId"));
export type SlotId = typeof SlotId.Type;

export const RunnerLabel = Schema.NonEmptyString.pipe(
	Schema.brand("RunnerLabel"),
);
export type RunnerLabel = typeof RunnerLabel.Type;

export const PayerId = Schema.NonEmptyString.pipe(Schema.brand("PayerId"));
export type PayerId = typeof PayerId.Type;

export const ExternalRunnerId = Schema.NonEmptyString.pipe(
	Schema.brand("ExternalRunnerId"),
);
export type ExternalRunnerId = typeof ExternalRunnerId.Type;

export const NonEmptyReason = Schema.NonEmptyString.pipe(
	Schema.brand("NonEmptyReason"),
);
export type NonEmptyReason = typeof NonEmptyReason.Type;

export const NonNegativeMicros = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("NonNegativeMicros"));
export type NonNegativeMicros = typeof NonNegativeMicros.Type;

export const NonNegativeCount = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("NonNegativeCount"));
export type NonNegativeCount = typeof NonNegativeCount.Type;

export const PositiveConcurrency = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(1),
).pipe(Schema.brand("PositiveConcurrency"));
export type PositiveConcurrency = typeof PositiveConcurrency.Type;

export const PositiveMinutes = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(1),
).pipe(Schema.brand("PositiveMinutes"));
export type PositiveMinutes = typeof PositiveMinutes.Type;

export const PositiveSeconds = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(1),
).pipe(Schema.brand("PositiveSeconds"));
export type PositiveSeconds = typeof PositiveSeconds.Type;

export const PositiveAttempts = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(1),
).pipe(Schema.brand("PositiveAttempts"));
export type PositiveAttempts = typeof PositiveAttempts.Type;

export const RunnerTier = Schema.Literals([
	"local",
	"hostinger",
	"agent37",
	"boat",
	"hosted",
]);
export type RunnerTier = typeof RunnerTier.Type;

export const PoolRole = Schema.Literals(["primary", "overflow", "last-resort"]);
export type PoolRole = typeof PoolRole.Type;

export const RunnerPoolHealth = Schema.Literals([
	"healthy",
	"degraded",
	"unhealthy",
]);
export type RunnerPoolHealth = typeof RunnerPoolHealth.Type;

export const JobConclusion = Schema.Literals([
	"succeeded",
	"failed",
	"cancelled",
]);
export type JobConclusion = typeof JobConclusion.Type;

export const JobDispatchStatusTag = Schema.Literals([
	"Unobserved",
	"Queued",
	"Bound",
	"Completed",
	"Failed",
	"Expired",
]);
export type JobDispatchStatusTag = typeof JobDispatchStatusTag.Type;

export const RunnerPoolSpec = Schema.Struct({
	poolId: RunnerPoolId,
	tier: RunnerTier,
	role: PoolRole,
	runnerLabel: RunnerLabel,
	concurrency: PositiveConcurrency,
	costPerMinuteMicros: NonNegativeMicros,
	payer: PayerId,
	payerBudgetMicros: Schema.NullOr(NonNegativeMicros),
	isolated: Schema.Boolean,
	docker: Schema.Boolean,
	publicRepositories: Schema.Boolean,
});
export type RunnerPoolSpec = typeof RunnerPoolSpec.Type;

export const JobRequirements = Schema.Struct({
	minutes: PositiveMinutes,
	needsDocker: Schema.Boolean,
	isolationRequired: Schema.Boolean,
	publicRepository: Schema.Boolean,
});
export type JobRequirements = typeof JobRequirements.Type;
