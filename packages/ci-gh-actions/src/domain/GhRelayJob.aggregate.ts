import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
	GhAccountId,
	GhJobContext,
	GhMachineId,
	GhRelayJobId,
	GhRelayJobStatusTag,
	GhRepoSlug,
	GhRouteSkip,
	GhRunnerLabel,
	GhStepKey,
	NonEmptyReason,
} from "./ids.js";

export class GhJobNotQueued extends Domain.Rejection("GhJobNotQueued", {
	currentState: GhRelayJobStatusTag,
}) {}

export class GhJobNotClaimed extends Domain.Rejection("GhJobNotClaimed", {
	currentState: GhRelayJobStatusTag,
}) {}

export class GhCheckMixedStepsRefused extends Domain.Rejection(
	"GhCheckMixedStepsRefused",
	{
		reason: NonEmptyReason,
	},
) {}

export class GhRelayJobQueued extends Domain.Event("GhRelayJobQueued", {
	context: GhJobContext,
}) {}

export class GhRelayJobClaimed extends Domain.Event("GhRelayJobClaimed", {
	accountId: GhAccountId,
	repository: GhRepoSlug,
	nodeId: Schema.NonEmptyString,
}) {}

export class GhRelayJobRouted extends Domain.Event("GhRelayJobRouted", {
	step: GhStepKey,
	runnerLabel: GhRunnerLabel,
	machineId: Schema.NullOr(GhMachineId),
	skipped: Schema.Array(GhRouteSkip),
	notInOrder: Schema.Array(GhStepKey),
}) {}

export class GhRelayJobWaiting extends Domain.Event("GhRelayJobWaiting", {
	step: GhStepKey,
	runnerLabel: GhRunnerLabel,
	machineId: Schema.NullOr(GhMachineId),
	skipped: Schema.Array(GhRouteSkip),
}) {}

export class GhRelayCheckCompleted extends Domain.Event(
	"GhRelayCheckCompleted",
	{
		passed: Schema.Boolean,
		annotations: Schema.Array(NonEmptyReason),
		summary: NonEmptyReason,
	},
) {}

export class GhRelayJobFailed extends Domain.Event("GhRelayJobFailed", {
	reason: NonEmptyReason,
	annotations: Schema.Array(NonEmptyReason),
}) {}

export class GhRelayJobExpired extends Domain.Event("GhRelayJobExpired", {
	reason: NonEmptyReason,
}) {}

export class QueueGhRelayJob extends Domain.Command(
	"QueueGhRelayJob",
	{
		target: GhRelayJobId,
		input: {
			context: GhJobContext,
		},
		events: [GhRelayJobQueued],
		rejects: [GhCheckMixedStepsRefused],
	},
	{
		description:
			"Queue a GitHub Actions relay or check job while refusing check jobs that mix non-check steps.",
	},
) {}

export class ClaimGhRelayJob extends Domain.Command(
	"ClaimGhRelayJob",
	{
		target: GhRelayJobId,
		input: {
			nodeId: Schema.NonEmptyString,
		},
		events: [GhRelayJobClaimed],
		rejects: [GhJobNotQueued],
	},
	{
		description: "Claim a queued relay job once on a relay node.",
	},
) {}

export class RecordGhRelayRouted extends Domain.Command(
	"RecordGhRelayRouted",
	{
		target: GhRelayJobId,
		input: {
			step: GhStepKey,
			runnerLabel: GhRunnerLabel,
			machineId: Schema.NullOr(GhMachineId),
			skipped: Schema.Array(GhRouteSkip),
			notInOrder: Schema.Array(GhStepKey),
		},
		events: [GhRelayJobRouted],
		rejects: [GhJobNotClaimed],
	},
	{
		description: "Complete a claimed relay job with its chosen runner label.",
	},
) {}

export class RecordGhRelayWaiting extends Domain.Command(
	"RecordGhRelayWaiting",
	{
		target: GhRelayJobId,
		input: {
			step: GhStepKey,
			runnerLabel: GhRunnerLabel,
			machineId: Schema.NullOr(GhMachineId),
			skipped: Schema.Array(GhRouteSkip),
		},
		events: [GhRelayJobWaiting],
		rejects: [GhJobNotClaimed],
	},
	{
		description:
			"Record that a claimed relay job is waiting in line for a busy machine or fleet.",
	},
) {}

export class RecordGhCheckCompleted extends Domain.Command(
	"RecordGhCheckCompleted",
	{
		target: GhRelayJobId,
		input: {
			passed: Schema.Boolean,
			annotations: Schema.Array(NonEmptyReason),
			summary: NonEmptyReason,
		},
		events: [GhRelayCheckCompleted],
		rejects: [GhJobNotClaimed],
	},
	{
		description:
			"Complete a runner-less pr-title or sandboxed lint check job with annotations and zero billed minutes.",
	},
) {}

export class FailGhRelayJob extends Domain.Command(
	"FailGhRelayJob",
	{
		target: GhRelayJobId,
		input: {
			reason: NonEmptyReason,
			annotations: Schema.Array(NonEmptyReason),
		},
		events: [GhRelayJobFailed],
		rejects: [],
	},
	{
		description:
			"Fail a relay job with a one-sentence error annotation when nothing fits or delivery fails.",
	},
) {}

export class ExpireGhRelayJob extends Domain.Command(
	"ExpireGhRelayJob",
	{
		target: GhRelayJobId,
		input: {
			reason: NonEmptyReason,
		},
		events: [GhRelayJobExpired],
		rejects: [],
	},
	{
		description: "Expire an unanswered queued relay job.",
	},
) {}

export const GhRelayJobState = Schema.Union([
	Schema.TaggedStruct("Unobserved", {}),
	Schema.TaggedStruct("Queued", {
		context: GhJobContext,
	}),
	Schema.TaggedStruct("Claimed", {
		context: GhJobContext,
		nodeId: Schema.NonEmptyString,
	}),
	Schema.TaggedStruct("Routed", {
		accountId: GhAccountId,
		repository: GhRepoSlug,
		step: GhStepKey,
		runnerLabel: GhRunnerLabel,
		machineId: Schema.NullOr(GhMachineId),
		skipped: Schema.Array(GhRouteSkip),
		notInOrder: Schema.Array(GhStepKey),
	}),
	Schema.TaggedStruct("Waiting", {
		accountId: GhAccountId,
		repository: GhRepoSlug,
		step: GhStepKey,
		runnerLabel: GhRunnerLabel,
		machineId: Schema.NullOr(GhMachineId),
		skipped: Schema.Array(GhRouteSkip),
	}),
	Schema.TaggedStruct("CheckPassed", {
		accountId: GhAccountId,
		repository: GhRepoSlug,
		summary: NonEmptyReason,
		annotations: Schema.Array(NonEmptyReason),
	}),
	Schema.TaggedStruct("CheckFailed", {
		accountId: GhAccountId,
		repository: GhRepoSlug,
		summary: NonEmptyReason,
		annotations: Schema.Array(NonEmptyReason),
	}),
	Schema.TaggedStruct("RouteFailed", {
		reason: NonEmptyReason,
		annotations: Schema.Array(NonEmptyReason),
	}),
	Schema.TaggedStruct("Expired", {
		reason: NonEmptyReason,
	}),
]);
export type GhRelayJobState = typeof GhRelayJobState.Type;

export class GhRelayJob extends Domain.Aggregate("GhRelayJob", {
	id: GhRelayJobId,
	state: GhRelayJobState,
	initial: { _tag: "Unobserved" },
	commands: [
		QueueGhRelayJob,
		ClaimGhRelayJob,
		RecordGhRelayRouted,
		RecordGhRelayWaiting,
		RecordGhCheckCompleted,
		FailGhRelayJob,
		ExpireGhRelayJob,
	],
	decide: {
		QueueGhRelayJob: (state, cmd) => {
			if (state._tag !== "Unobserved") return [];
			if (cmd.context.checkSteps.length > 0 && cmd.context.hasNonCheckSteps) {
				return new GhCheckMixedStepsRefused({
					reason: NonEmptyReason.make(
						"A relay check job must contain only HoBo check steps and never runs scripts or other steps.",
					),
				});
			}
			return [new GhRelayJobQueued({ context: cmd.context })];
		},
		ClaimGhRelayJob: (state, cmd) => {
			if (state._tag === "Claimed" && state.nodeId === cmd.nodeId) return [];
			if (state._tag !== "Queued") {
				return new GhJobNotQueued({ currentState: state._tag });
			}
			return [
				new GhRelayJobClaimed({
					accountId: state.context.accountId,
					repository: state.context.repository,
					nodeId: cmd.nodeId,
				}),
			];
		},
		RecordGhRelayRouted: (state, cmd) => {
			if (state._tag === "Routed") return [];
			if (state._tag !== "Claimed") {
				return new GhJobNotClaimed({ currentState: state._tag });
			}
			return [
				new GhRelayJobRouted({
					step: cmd.step,
					runnerLabel: cmd.runnerLabel,
					machineId: cmd.machineId,
					skipped: cmd.skipped,
					notInOrder: cmd.notInOrder,
				}),
			];
		},
		RecordGhRelayWaiting: (state, cmd) => {
			if (state._tag === "Waiting") return [];
			if (state._tag !== "Claimed") {
				return new GhJobNotClaimed({ currentState: state._tag });
			}
			return [
				new GhRelayJobWaiting({
					step: cmd.step,
					runnerLabel: cmd.runnerLabel,
					machineId: cmd.machineId,
					skipped: cmd.skipped,
				}),
			];
		},
		RecordGhCheckCompleted: (state, cmd) => {
			if (state._tag === "CheckPassed" || state._tag === "CheckFailed") {
				return [];
			}
			if (state._tag !== "Claimed") {
				return new GhJobNotClaimed({ currentState: state._tag });
			}
			return [
				new GhRelayCheckCompleted({
					passed: cmd.passed,
					annotations: cmd.annotations,
					summary: cmd.summary,
				}),
			];
		},
		FailGhRelayJob: (state, cmd) =>
			state._tag === "Queued" || state._tag === "Claimed"
				? [
						new GhRelayJobFailed({
							reason: cmd.reason,
							annotations: cmd.annotations,
						}),
					]
				: [],
		ExpireGhRelayJob: (state, cmd) =>
			state._tag === "Queued"
				? [new GhRelayJobExpired({ reason: cmd.reason })]
				: [],
	},
	evolve: {
		GhRelayJobQueued: (_state, event) => ({
			_tag: "Queued" as const,
			context: event.context,
		}),
		GhRelayJobClaimed: (state, event) =>
			state._tag === "Queued"
				? {
						_tag: "Claimed" as const,
						context: state.context,
						nodeId: event.nodeId,
					}
				: state,
		GhRelayJobRouted: (state, event) =>
			state._tag === "Claimed"
				? {
						_tag: "Routed" as const,
						accountId: state.context.accountId,
						repository: state.context.repository,
						step: event.step,
						runnerLabel: event.runnerLabel,
						machineId: event.machineId,
						skipped: event.skipped,
						notInOrder: event.notInOrder,
					}
				: state,
		GhRelayJobWaiting: (state, event) =>
			state._tag === "Claimed"
				? {
						_tag: "Waiting" as const,
						accountId: state.context.accountId,
						repository: state.context.repository,
						step: event.step,
						runnerLabel: event.runnerLabel,
						machineId: event.machineId,
						skipped: event.skipped,
					}
				: state,
		GhRelayCheckCompleted: (state, event) =>
			state._tag === "Claimed"
				? {
						_tag: event.passed
							? ("CheckPassed" as const)
							: ("CheckFailed" as const),
						accountId: state.context.accountId,
						repository: state.context.repository,
						summary: event.summary,
						annotations: event.annotations,
					}
				: state,
		GhRelayJobFailed: (_state, event) => ({
			_tag: "RouteFailed" as const,
			reason: event.reason,
			annotations: event.annotations,
		}),
		GhRelayJobExpired: (_state, event) => ({
			_tag: "Expired" as const,
			reason: event.reason,
		}),
	},
}) {}
