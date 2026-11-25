import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
	ExternalRunnerId,
	JobDispatchId,
	NonEmptyReason,
	RunnerLabel,
	RunnerPoolId,
	RunnerTier,
	SlotId,
	StationId,
} from "./ids.js";

export class RunnerCapacityExhausted extends Domain.Rejection(
	"RunnerCapacityExhausted",
	{
		poolId: RunnerPoolId,
		reason: NonEmptyReason,
	},
) {}

export class RunnerProvisionFailed extends Domain.Rejection(
	"RunnerProvisionFailed",
	{
		poolId: RunnerPoolId,
		reason: NonEmptyReason,
	},
) {}

export class RunnerReleaseFailed extends Domain.Rejection(
	"RunnerReleaseFailed",
	{
		slotId: SlotId,
		reason: NonEmptyReason,
	},
) {}

export class RunnerBackend extends Domain.ExternalSystem("RunnerBackend", {
	provisionRunner: {
		args: {
			stationId: StationId,
			jobId: JobDispatchId,
			poolId: RunnerPoolId,
			tier: RunnerTier,
			runnerLabel: RunnerLabel,
			slotId: SlotId,
		},
		success: {
			externalRunnerId: ExternalRunnerId,
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
		error: [RunnerReleaseFailed],
	},
}) {}
