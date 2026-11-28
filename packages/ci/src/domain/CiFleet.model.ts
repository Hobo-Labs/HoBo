import * as Domain from "@alchemy.run/domain";
import * as Layer from "effect/Layer";
import { DispatchJob, DispatchJobLive } from "./DispatchJob.saga.js";
import { JobDispatch } from "./JobDispatch.aggregate.js";
import {
	JobCompletedPolicy,
	JobCompletedPolicyLive,
	JobExpiredPolicy,
	JobExpiredPolicyLive,
	JobObservedPolicy,
	JobObservedPolicyLive,
} from "./JobDispatch.policies.js";
import { StationFleet } from "./StationFleet.aggregate.js";
import { RoutingAuditView, StationCapacityView } from "./views.js";

export class CiFleet extends Domain.Model(
	"CiFleet",
	{
		aggregates: [StationFleet, JobDispatch],
		views: [StationCapacityView, RoutingAuditView],
		policies: [JobObservedPolicy, JobCompletedPolicy, JobExpiredPolicy],
		sagas: [DispatchJob],
	},
	{
		description:
			"Balanced CI runner dispatch across local, Hostinger, Agent37, Boat, and hosted pools.",
	},
) {}

export const CiFleetHandlers = Layer.mergeAll(
	JobObservedPolicyLive,
	JobCompletedPolicyLive,
	JobExpiredPolicyLive,
	DispatchJobLive,
);

export class CiFleetApi extends Domain.Api(
	"CiFleetApi",
	{
		model: CiFleet,
		commands: [
			"ConfigureStationBudget",
			"RegisterRunnerPool",
			"SetRunnerPoolHealth",
			"ObserveJobDispatch",
			"CompleteJobDispatch",
		],
		views: ["StationCapacityView", "RoutingAuditView"],
	},
	{
		description:
			"Control API for registering runner pools, dispatching balanced CI jobs, and inspecting fleet capacity.",
	},
) {}
