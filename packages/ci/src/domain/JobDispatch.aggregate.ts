import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
	ExternalRunnerId,
	JobConclusion,
	JobDispatchId,
	JobDispatchStatusTag,
	JobRequirements,
	NonEmptyReason,
	NonNegativeMicros,
	PositiveAttempts,
	PositiveSeconds,
	RunnerPoolId,
	RunnerTier,
	RunsOnLabel,
	SlotId,
	StationId,
} from "./ids.js";

export class JobNotQueued extends Domain.Rejection("JobNotQueued", {
	currentState: JobDispatchStatusTag,
}) {}

export class StartBindingConflict extends Domain.Rejection(
	"StartBindingConflict",
	{
		boundSlotId: SlotId,
		boundPoolId: RunnerPoolId,
		attemptedSlotId: SlotId,
	},
) {}

export class JobNotBound extends Domain.Rejection("JobNotBound", {
	currentState: JobDispatchStatusTag,
}) {}

export class JobDispatchObserved extends Domain.Event("JobDispatchObserved", {
	stationId: StationId,
	requirements: JobRequirements,
	deadlineSeconds: Schema.NullOr(PositiveSeconds),
}) {}

export class RunnerStartBound extends Domain.Event("RunnerStartBound", {
	stationId: StationId,
	poolId: RunnerPoolId,
	tier: RunnerTier,
	slotId: SlotId,
	runsOn: RunsOnLabel,
	externalRunnerId: ExternalRunnerId,
	attempts: PositiveAttempts,
}) {}

export class JobDispatchCompleted extends Domain.Event("JobDispatchCompleted", {
	stationId: StationId,
	slotId: SlotId,
	settledMicros: NonNegativeMicros,
	conclusion: JobConclusion,
}) {}

export class JobDispatchFailed extends Domain.Event("JobDispatchFailed", {
	reason: NonEmptyReason,
}) {}

export class JobDispatchExpired extends Domain.Event("JobDispatchExpired", {
	reason: NonEmptyReason,
}) {}

export class ObserveJobDispatch extends Domain.Command(
	"ObserveJobDispatch",
	{
		target: JobDispatchId,
		input: {
			stationId: StationId,
			requirements: JobRequirements,
			deadlineSeconds: Schema.NullOr(PositiveSeconds),
		},
		events: [JobDispatchObserved],
		rejects: [],
	},
	{ description: "Observe incoming CI job demand for balanced dispatch." },
) {}

export class BindRunnerStart extends Domain.Command(
	"BindRunnerStart",
	{
		target: JobDispatchId,
		input: {
			poolId: RunnerPoolId,
			tier: RunnerTier,
			slotId: SlotId,
			runsOn: RunsOnLabel,
			externalRunnerId: ExternalRunnerId,
			attempts: PositiveAttempts,
		},
		events: [RunnerStartBound],
		rejects: [JobNotQueued, StartBindingConflict],
	},
	{
		description:
			"Bind an observed CI job immutably to its starting runner assignment.",
	},
) {}

export class CompleteJobDispatch extends Domain.Command(
	"CompleteJobDispatch",
	{
		target: JobDispatchId,
		input: {
			settledMicros: NonNegativeMicros,
			conclusion: JobConclusion,
		},
		events: [JobDispatchCompleted],
		rejects: [JobNotBound],
	},
	{
		description:
			"Record completion of a bound CI job and trigger slot release.",
	},
) {}

export class FailJobDispatch extends Domain.Command(
	"FailJobDispatch",
	{
		target: JobDispatchId,
		input: {
			reason: NonEmptyReason,
		},
		events: [JobDispatchFailed],
		rejects: [],
	},
	{
		description: "Record dispatch failure when all runner tiers are exhausted.",
	},
) {}

export class ExpireJobDispatch extends Domain.Command(
	"ExpireJobDispatch",
	{
		target: JobDispatchId,
		input: {
			reason: NonEmptyReason,
		},
		events: [JobDispatchExpired],
		rejects: [],
	},
	{
		description:
			"Expire an unbound queued CI job once its queue deadline elapses.",
	},
) {}

export const JobDispatchState = Schema.Union([
	Schema.TaggedStruct("Unobserved", {}),
	Schema.TaggedStruct("Queued", {
		stationId: StationId,
		requirements: JobRequirements,
	}),
	Schema.TaggedStruct("Bound", {
		stationId: StationId,
		poolId: RunnerPoolId,
		tier: RunnerTier,
		slotId: SlotId,
		runsOn: RunsOnLabel,
		externalRunnerId: ExternalRunnerId,
		attempts: PositiveAttempts,
	}),
	Schema.TaggedStruct("Completed", {
		stationId: StationId,
		poolId: RunnerPoolId,
		tier: RunnerTier,
		slotId: SlotId,
		settledMicros: NonNegativeMicros,
		conclusion: JobConclusion,
	}),
	Schema.TaggedStruct("Failed", {
		reason: NonEmptyReason,
	}),
	Schema.TaggedStruct("Expired", {
		reason: NonEmptyReason,
	}),
]);
export type JobDispatchState = typeof JobDispatchState.Type;

export class JobDispatch extends Domain.Aggregate("JobDispatch", {
	id: JobDispatchId,
	state: JobDispatchState,
	initial: { _tag: "Unobserved" },
	commands: [
		ObserveJobDispatch,
		BindRunnerStart,
		CompleteJobDispatch,
		FailJobDispatch,
		ExpireJobDispatch,
	],
	decide: {
		ObserveJobDispatch: (state, cmd) =>
			state._tag === "Unobserved"
				? [
						new JobDispatchObserved({
							stationId: cmd.stationId,
							requirements: cmd.requirements,
							deadlineSeconds: cmd.deadlineSeconds,
						}),
					]
				: [],
		BindRunnerStart: (state, cmd) => {
			if (state._tag === "Bound") {
				if (
					state.slotId === cmd.slotId &&
					state.poolId === cmd.poolId &&
					state.externalRunnerId === cmd.externalRunnerId
				) {
					return [];
				}
				return new StartBindingConflict({
					boundSlotId: state.slotId,
					boundPoolId: state.poolId,
					attemptedSlotId: cmd.slotId,
				});
			}
			if (state._tag !== "Queued") {
				return new JobNotQueued({ currentState: state._tag });
			}
			return [
				new RunnerStartBound({
					stationId: state.stationId,
					poolId: cmd.poolId,
					tier: cmd.tier,
					slotId: cmd.slotId,
					runsOn: cmd.runsOn,
					externalRunnerId: cmd.externalRunnerId,
					attempts: cmd.attempts,
				}),
			];
		},
		CompleteJobDispatch: (state, cmd) => {
			if (state._tag === "Completed") return [];
			if (state._tag !== "Bound") {
				return new JobNotBound({ currentState: state._tag });
			}
			return [
				new JobDispatchCompleted({
					stationId: state.stationId,
					slotId: state.slotId,
					settledMicros: cmd.settledMicros,
					conclusion: cmd.conclusion,
				}),
			];
		},
		FailJobDispatch: (state, cmd) =>
			state._tag === "Queued"
				? [new JobDispatchFailed({ reason: cmd.reason })]
				: [],
		ExpireJobDispatch: (state, cmd) =>
			state._tag === "Queued"
				? [new JobDispatchExpired({ reason: cmd.reason })]
				: [],
	},
	evolve: {
		JobDispatchObserved: (_state, event) => ({
			_tag: "Queued" as const,
			stationId: event.stationId,
			requirements: event.requirements,
		}),
		RunnerStartBound: (_state, event) => ({
			_tag: "Bound" as const,
			stationId: event.stationId,
			poolId: event.poolId,
			tier: event.tier,
			slotId: event.slotId,
			runsOn: event.runsOn,
			externalRunnerId: event.externalRunnerId,
			attempts: event.attempts,
		}),
		JobDispatchCompleted: (state, event) =>
			state._tag === "Bound"
				? {
						_tag: "Completed" as const,
						stationId: event.stationId,
						poolId: state.poolId,
						tier: state.tier,
						slotId: event.slotId,
						settledMicros: event.settledMicros,
						conclusion: event.conclusion,
					}
				: state,
		JobDispatchFailed: (_state, event) => ({
			_tag: "Failed" as const,
			reason: event.reason,
		}),
		JobDispatchExpired: (_state, event) => ({
			_tag: "Expired" as const,
			reason: event.reason,
		}),
	},
}) {}
