import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
	CampTargetId,
	CdFanoutId,
	CdFanoutPhase,
	FreightDigest,
	NonEmptyReason,
	NonNegativeCount,
	UniqueCampWave,
} from "./ids.js";

export class FanoutAlreadyStarted extends Domain.Rejection(
	"FanoutAlreadyStarted",
	{ phase: CdFanoutPhase },
) {}

export class FanoutNotRunning extends Domain.Rejection("FanoutNotRunning", {
	phase: CdFanoutPhase,
}) {}

export class CampNotInWave extends Domain.Rejection("CampNotInWave", {
	campId: CampTargetId,
}) {}

export class CampOutcomeAlreadyRecorded extends Domain.Rejection(
	"CampOutcomeAlreadyRecorded",
	{
		campId: CampTargetId,
	},
) {}

export class CdFanoutStarted extends Domain.Event("CdFanoutStarted", {
	freightDigest: FreightDigest,
	campIds: UniqueCampWave,
	maxFailures: NonNegativeCount,
}) {}

export class CdFanoutCampUpdated extends Domain.Event("CdFanoutCampUpdated", {
	campId: CampTargetId,
	succeeded: Schema.Boolean,
	reason: Schema.NullOr(NonEmptyReason),
}) {}

export class CdFanoutHalted extends Domain.Event("CdFanoutHalted", {
	failedCount: NonNegativeCount,
	maxFailures: NonNegativeCount,
	reason: NonEmptyReason,
}) {}

export class CdFanoutCompleted extends Domain.Event("CdFanoutCompleted", {
	succeededCount: NonNegativeCount,
}) {}

export class StartCdFanout extends Domain.Command(
	"StartCdFanout",
	{
		target: CdFanoutId,
		input: {
			freightDigest: FreightDigest,
			campIds: UniqueCampWave,
			maxFailures: NonNegativeCount,
		},
		events: [CdFanoutStarted],
		rejects: [FanoutAlreadyStarted],
	},
	{
		description:
			"Start a multi-camp wave fanout with a non-empty unique wave and failure budget.",
	},
) {}

export class RecordFanoutCampOutcome extends Domain.Command(
	"RecordFanoutCampOutcome",
	{
		target: CdFanoutId,
		input: {
			campId: CampTargetId,
			succeeded: Schema.Boolean,
			reason: Schema.NullOr(NonEmptyReason),
		},
		events: [CdFanoutCampUpdated, CdFanoutHalted, CdFanoutCompleted],
		rejects: [FanoutNotRunning, CampNotInWave, CampOutcomeAlreadyRecorded],
	},
	{
		description:
			"Record one camp wave result and halt automatically if failure budget is exceeded.",
	},
) {}

export const CdFanoutState = Schema.Union([
	Schema.TaggedStruct("Idle", {}),
	Schema.TaggedStruct("Running", {
		freightDigest: FreightDigest,
		campIds: UniqueCampWave,
		succeededCamps: Schema.Array(CampTargetId),
		failedCamps: Schema.Array(CampTargetId),
		maxFailures: NonNegativeCount,
	}),
	Schema.TaggedStruct("Completed", {
		freightDigest: FreightDigest,
		campIds: UniqueCampWave,
		succeededCamps: Schema.Array(CampTargetId),
		failedCamps: Schema.Array(CampTargetId),
		maxFailures: NonNegativeCount,
	}),
	Schema.TaggedStruct("Halted", {
		freightDigest: FreightDigest,
		campIds: UniqueCampWave,
		succeededCamps: Schema.Array(CampTargetId),
		failedCamps: Schema.Array(CampTargetId),
		maxFailures: NonNegativeCount,
		haltReason: NonEmptyReason,
	}),
]);
export type CdFanoutState = typeof CdFanoutState.Type;

function fanoutPhaseOf(state: CdFanoutState): CdFanoutPhase {
	switch (state._tag) {
		case "Idle":
			return "idle";
		case "Running":
			return "running";
		case "Completed":
			return "completed";
		case "Halted":
			return "halted";
	}
}

export class CdFanout extends Domain.Aggregate("CdFanout", {
	id: CdFanoutId,
	state: CdFanoutState,
	initial: { _tag: "Idle" },
	commands: [StartCdFanout, RecordFanoutCampOutcome],
	decide: {
		StartCdFanout: (state, cmd) => {
			if (state._tag !== "Idle") {
				return new FanoutAlreadyStarted({ phase: fanoutPhaseOf(state) });
			}
			return [
				new CdFanoutStarted({
					freightDigest: cmd.freightDigest,
					campIds: cmd.campIds,
					maxFailures: cmd.maxFailures,
				}),
			];
		},
		RecordFanoutCampOutcome: (state, cmd) => {
			if (state._tag !== "Running") {
				return new FanoutNotRunning({ phase: fanoutPhaseOf(state) });
			}
			if (!state.campIds.includes(cmd.campId)) {
				return new CampNotInWave({ campId: cmd.campId });
			}
			if (
				state.succeededCamps.includes(cmd.campId) ||
				state.failedCamps.includes(cmd.campId)
			) {
				return new CampOutcomeAlreadyRecorded({ campId: cmd.campId });
			}

			const updatedEvent = new CdFanoutCampUpdated({
				campId: cmd.campId,
				succeeded: cmd.succeeded,
				reason: cmd.reason,
			});
			const nextFailed = NonNegativeCount.make(
				cmd.succeeded ? state.failedCamps.length : state.failedCamps.length + 1,
			);
			const nextSucceeded = NonNegativeCount.make(
				cmd.succeeded
					? state.succeededCamps.length + 1
					: state.succeededCamps.length,
			);

			if (!cmd.succeeded && nextFailed > state.maxFailures) {
				return [
					updatedEvent,
					new CdFanoutHalted({
						failedCount: nextFailed,
						maxFailures: state.maxFailures,
						reason:
							cmd.reason ?? NonEmptyReason.make("failure-budget-exceeded"),
					}),
				];
			}
			if (nextSucceeded + nextFailed >= state.campIds.length) {
				return [
					updatedEvent,
					new CdFanoutCompleted({ succeededCount: nextSucceeded }),
				];
			}
			return [updatedEvent];
		},
	},
	evolve: {
		CdFanoutStarted: (_state, event) => ({
			_tag: "Running" as const,
			freightDigest: event.freightDigest,
			campIds: event.campIds,
			succeededCamps: [],
			failedCamps: [],
			maxFailures: event.maxFailures,
		}),
		CdFanoutCampUpdated: (state, event) =>
			state._tag === "Running"
				? {
						...state,
						succeededCamps: event.succeeded
							? [...state.succeededCamps, event.campId]
							: state.succeededCamps,
						failedCamps: event.succeeded
							? state.failedCamps
							: [...state.failedCamps, event.campId],
					}
				: state,
		CdFanoutHalted: (state, event) =>
			state._tag === "Running"
				? {
						_tag: "Halted" as const,
						freightDigest: state.freightDigest,
						campIds: state.campIds,
						succeededCamps: state.succeededCamps,
						failedCamps: state.failedCamps,
						maxFailures: state.maxFailures,
						haltReason: event.reason,
					}
				: state,
		CdFanoutCompleted: (state) =>
			state._tag === "Running"
				? {
						_tag: "Completed" as const,
						freightDigest: state.freightDigest,
						campIds: state.campIds,
						succeededCamps: state.succeededCamps,
						failedCamps: state.failedCamps,
						maxFailures: state.maxFailures,
					}
				: state,
	},
}) {}
