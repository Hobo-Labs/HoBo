import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
	GhAccountId,
	GhLintTool,
	GhRelayJobId,
	GhRepoSlug,
	GhRunnerLabel,
	NonEmptyReason,
	NonNegativeCount,
	PositiveRunId,
} from "./ids.js";

export class GhProtocolRejected extends Domain.Rejection("GhProtocolRejected", {
	reason: NonEmptyReason,
}) {}

export class GhSandboxFailed extends Domain.Rejection("GhSandboxFailed", {
	tool: GhLintTool,
	reason: NonEmptyReason,
}) {}

export class GhRunnerProtocol extends Domain.ExternalSystem(
	"GhRunnerProtocol",
	{
		answerJob: {
			args: {
				accountId: GhAccountId,
				repository: GhRepoSlug,
				jobId: GhRelayJobId,
				conclusion: Schema.Literals(["succeeded", "failed"]),
				runnerLabel: Schema.NullOr(GhRunnerLabel),
				annotations: Schema.Array(NonEmptyReason),
			},
			success: {
				accepted: Schema.Boolean,
			},
			error: [GhProtocolRejected],
		},
		rerunFailedJobs: {
			args: {
				accountId: GhAccountId,
				repository: GhRepoSlug,
				runId: PositiveRunId,
			},
			success: {
				triggered: Schema.Boolean,
			},
			error: [GhProtocolRejected],
		},
	},
) {}

export class GhLintSandbox extends Domain.ExternalSystem("GhLintSandbox", {
	runTool: {
		args: {
			repository: GhRepoSlug,
			tool: GhLintTool,
			paths: Schema.Array(Schema.NonEmptyString),
			network: Schema.Literals(["none"]),
		},
		success: {
			passed: Schema.Boolean,
			summary: NonEmptyReason,
			findingCount: NonNegativeCount,
		},
		error: [GhSandboxFailed],
	},
}) {}
