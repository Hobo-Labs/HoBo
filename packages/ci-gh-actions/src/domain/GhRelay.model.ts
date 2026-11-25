import * as Domain from "@alchemy.run/domain";
import * as Layer from "effect/Layer";
import {
	AnswerGhRelayJob,
	AnswerGhRelayJobLive,
} from "./AnswerGhRelayJob.saga.js";
import { GhMachinePool } from "./GhMachinePool.aggregate.js";
import {
	GhRelayJobQueuedPolicy,
	GhRelayJobQueuedPolicyLive,
} from "./GhRelay.policies.js";
import { GhRelayJob } from "./GhRelayJob.aggregate.js";
import { GhRelayRouter } from "./GhRelayRouter.aggregate.js";
import { GhAccountStatusView, GhRelayActivityView } from "./views.js";

export class GhRelay extends Domain.Model(
	"GhRelay",
	{
		aggregates: [GhMachinePool, GhRelayRouter, GhRelayJob],
		views: [GhRelayActivityView, GhAccountStatusView],
		policies: [GhRelayJobQueuedPolicy],
		sagas: [AnswerGhRelayJob],
	},
	{
		description:
			"GitHub Actions relay runner control plane covering ordered routing, structured runs-on specs, machine pools, provider health, auto-retries, and runner-less checks.",
	},
) {}

export const GhRelayHandlers = Layer.mergeAll(
	GhRelayJobQueuedPolicyLive,
	AnswerGhRelayJobLive,
);

export class GhRelayApi extends Domain.Api(
	"GhRelayApi",
	{
		model: GhRelay,
		commands: [
			"ConfigureGhRunnerOrder",
			"SyncGhMinutesUsage",
			"SyncGhProviderSpend",
			"RecordGhProviderMiss",
			"ClearGhProviderHealth",
			"ConnectGhMachine",
			"VerifyGhMachineAdvert",
			"PauseGhMachine",
			"ResumeGhMachine",
			"RemoveGhMachine",
			"ReleaseGhMachineSlot",
			"QueueGhRelayJob",
			"RequestGhJobAutoRetry",
		],
		views: ["GhRelayActivityView", "GhAccountStatusView"],
	},
	{
		description:
			"Control API for configuring GitHub Actions runner orders, managing connected machines, queuing relay/check jobs, and inspecting relay activity.",
	},
) {}
