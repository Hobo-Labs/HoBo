import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
	JobDispatchId,
	RunnerPoolId,
	RunnerTier,
	SlotId,
	StationId,
} from "./ids.js";

export class RunnerCapacityExhausted extends Domain.Rejection(
	"RunnerCapacityExhausted",
	{
		poolId: RunnerPoolId,
		reason: Schema.String,
	},
) {}

export class RunnerProvisionFailed extends Domain.Rejection(
	"RunnerProvisionFailed",
	{
		poolId: RunnerPoolId,
		reason: Schema.String,
	},
) {}

export class RunnerBackend extends Domain.ExternalSystem("RunnerBackend", {
	provisionRunner: {
		args: {
			stationId: StationId,
			jobId: JobDispatchId,
			poolId: RunnerPoolId,
			tier: RunnerTier,
			runsOn: Schema.String,
			slotId: SlotId,
		},
		success: {
			externalRunnerId: Schema.String,
		},
		error: [RunnerCapacityExhausted, RunnerProvisionFailed],
	},
	releaseRunner: {
		args: {
			stationId: StationId,
			slotId: SlotId,
		},
		success: {
			released: Schema.Boolean,
		},
	},
}) {}
