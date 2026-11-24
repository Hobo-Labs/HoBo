import * as Schema from "effect/Schema";

export const StationId = Schema.String.pipe(Schema.brand("StationId"));
export type StationId = typeof StationId.Type;

export const RunnerPoolId = Schema.String.pipe(Schema.brand("RunnerPoolId"));
export type RunnerPoolId = typeof RunnerPoolId.Type;

export const JobDispatchId = Schema.String.pipe(Schema.brand("JobDispatchId"));
export type JobDispatchId = typeof JobDispatchId.Type;

export const SlotId = Schema.String.pipe(Schema.brand("SlotId"));
export type SlotId = typeof SlotId.Type;

export const RunnerTier = Schema.Literals([
	"local",
	"hostinger",
	"agent37",
	"boat",
	"github",
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

export const RunnerPoolSpec = Schema.Struct({
	poolId: RunnerPoolId,
	tier: RunnerTier,
	role: PoolRole,
	runsOn: Schema.String,
	concurrency: Schema.Int,
	costPerMinuteMicros: Schema.Int,
	payer: Schema.String,
	payerBudgetMicros: Schema.NullOr(Schema.Int),
	isolated: Schema.Boolean,
	docker: Schema.Boolean,
	publicRepositories: Schema.Boolean,
});
export type RunnerPoolSpec = typeof RunnerPoolSpec.Type;

export const JobRequirements = Schema.Struct({
	minutes: Schema.Int,
	needsDocker: Schema.Boolean,
	isolationRequired: Schema.Boolean,
	publicRepository: Schema.Boolean,
});
export type JobRequirements = typeof JobRequirements.Type;
