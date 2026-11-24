import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { CampTargetId, CdFanoutId, CdFanoutPhase, FreightDigest } from "./ids.js";

export class FanoutAlreadyStarted extends Domain.Rejection(
	"FanoutAlreadyStarted",
	{ phase: CdFanoutPhase },
) {}

export class FanoutNotRunning extends Domain.Rejection("FanoutNotRunning", {
	phase: CdFanoutPhase,
}) {}

export class CdFanoutStarted extends Domain.Event("CdFanoutStarted", {
	freightDigest: FreightDigest,
	campIds: Schema.Array(CampTargetId),
	maxFailures: Schema.Int,
}) {}

export class CdFanoutCampUpdated extends Domain.Event("CdFanoutCampUpdated", {
	campId: CampTargetId,
	succeeded: Schema.Boolean,
	reason: Schema.NullOr(Schema.String),
}) {}

export class CdFanoutHalted extends Domain.Event("CdFanoutHalted", {
	failedCount: Schema.Int,
	maxFailures: Schema.Int,
	reason: Schema.String,
}) {}

export class CdFanoutCompleted extends Domain.Event("CdFanoutCompleted", {
	succeededCount: Schema.Int,
}) {}

export class StartCdFanout extends Domain.Command(
	"StartCdFanout",
	{
		target: CdFanoutId,
		input: {
			freightDigest: FreightDigest,
			campIds: Schema.Array(CampTargetId),
			maxFailures: Schema.Int,
		},
		events: [CdFanoutStarted],
		rejects: [FanoutAlreadyStarted],
	},
	{ description: "Start a multi-camp wave fanout with an explicit failure budget." },
) {}

export class RecordFanoutCampOutcome extends Domain.Command(
	"RecordFanoutCampOutcome",
	{
		target: CdFanoutId,
		input: {
			campId: CampTargetId,
			succeeded: Schema.Boolean,
			reason: Schema.NullOr(Schema.String),
		},
		events: [CdFanoutCampUpdated, CdFanoutHalted, CdFanoutCompleted],
		rejects: [FanoutNotRunning],
	},
	{ description: "Record one camp wave result and halt automatically if failure budget is exceeded." },
) {}

const CdFanoutState = Schema.Struct({
	phase: CdFanoutPhase,
	freightDigest: Schema.NullOr(FreightDigest),
	campIds: Schema.Array(CampTargetId),
	succeededCamps: Schema.Array(CampTargetId),
	failedCamps: Schema.Array(CampTargetId),
	maxFailures: Schema.Int,
	haltReason: Schema.NullOr(Schema.String),
});

export class CdFanout extends Domain.Aggregate("CdFanout", {
	id: CdFanoutId,
	state: CdFanoutState,
	initial: {
		phase: "idle" as const,
		freightDigest: null,
		campIds: [],
		succeededCamps: [],
		failedCamps: [],
		maxFailures: 0,
		haltReason: null,
	},
	commands: [StartCdFanout, RecordFanoutCampOutcome],
	decide: {
		StartCdFanout: (state, cmd) => {
			if (state.phase !== "idle") {
				return new FanoutAlreadyStarted({ phase: state.phase });
			}
			return [
				new CdFanoutStarted({
					freightDigest: cmd.freightDigest,
					campIds: cmd.campIds,
					maxFailures: Math.max(0, cmd.maxFailures),
				}),
			];
		},
		RecordFanoutCampOutcome: (state, cmd) => {
			if (state.phase !== "running") {
				return new FanoutNotRunning({ phase: state.phase });
			}
			const updatedEvent = new CdFanoutCampUpdated({
				campId: cmd.campId,
				succeeded: cmd.succeeded,
				reason: cmd.reason,
			});
			const nextFailed = cmd.succeeded
				? state.failedCamps.length
				: state.failedCamps.length + 1;
			const nextSucceeded = cmd.succeeded
				? state.succeededCamps.length + 1
				: state.succeededCamps.length;

			if (!cmd.succeeded && nextFailed > state.maxFailures) {
				return [
					updatedEvent,
					new CdFanoutHalted({
						failedCount: nextFailed,
						maxFailures: state.maxFailures,
						reason: cmd.reason ?? "failure-budget-exceeded",
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
		CdFanoutStarted: (state, event) => ({
			...state,
			phase: "running" as const,
			freightDigest: event.freightDigest,
			campIds: event.campIds,
			maxFailures: event.maxFailures,
		}),
		CdFanoutCampUpdated: (state, event) => ({
			...state,
			succeededCamps: event.succeeded
				? [...state.succeededCamps, event.campId]
				: state.succeededCamps,
			failedCamps: event.succeeded
				? state.failedCamps
				: [...state.failedCamps, event.campId],
		}),
		CdFanoutHalted: (state, event) => ({
			...state,
			phase: "halted" as const,
			haltReason: event.reason,
		}),
		CdFanoutCompleted: (state) => ({
			...state,
			phase: "completed" as const,
		}),
	},
}) {}
