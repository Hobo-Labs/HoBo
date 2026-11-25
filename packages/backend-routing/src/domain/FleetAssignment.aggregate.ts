import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
	decodeEpochMs,
	decodeEpochNumber,
	EpochMs,
	EpochNumber,
	FleetId,
	FleetMemberName,
	NonEmptyReason,
	NonNegativeMs,
	RoutingHysteresisMarks,
	SwitchCause,
	UnitFraction,
} from "./ids.js";

export class FleetAlreadyInitialized extends Domain.Rejection(
	"FleetAlreadyInitialized",
	{
		active: FleetMemberName,
		epoch: EpochNumber,
	},
) {}

export class FleetNotInitialized extends Domain.Rejection(
	"FleetNotInitialized",
	{
		fleetId: FleetId,
	},
) {}

export class FleetSwitchAlreadyInFlight extends Domain.Rejection(
	"FleetSwitchAlreadyInFlight",
	{
		active: FleetMemberName,
		target: FleetMemberName,
	},
) {}

export class NoSwitchInFlight extends Domain.Rejection("NoSwitchInFlight", {
	fleetId: FleetId,
}) {}

export class SwitchTargetMatchesActive extends Domain.Rejection(
	"SwitchTargetMatchesActive",
	{
		member: FleetMemberName,
	},
) {}

export class MinimumDwellNotReached extends Domain.Rejection(
	"MinimumDwellNotReached",
	{
		nextAllowedAtMs: EpochMs,
		nowMs: EpochMs,
	},
) {}

export class FailoverThresholdNotReached extends Domain.Rejection(
	"FailoverThresholdNotReached",
	{
		failingForMs: NonNegativeMs,
		failoverAfterMs: NonNegativeMs,
	},
) {}

export class FleetMemberNotInRoster extends Domain.Rejection(
	"FleetMemberNotInRoster",
	{
		member: FleetMemberName,
	},
) {}

export class SwitchUtilizationThresholdNotReached extends Domain.Rejection(
	"SwitchUtilizationThresholdNotReached",
	{
		observedUtilization: Schema.NullOr(UnitFraction),
		requiredUtilization: UnitFraction,
	},
) {}

export class FleetAssignmentInitialized extends Domain.Event(
	"FleetAssignmentInitialized",
	{
		active: FleetMemberName,
		members: Schema.Array(FleetMemberName),
		marks: RoutingHysteresisMarks,
		epoch: EpochNumber,
		decidedAtMs: EpochMs,
	},
) {}

export class FleetSwitchSealed extends Domain.Event("FleetSwitchSealed", {
	from: FleetMemberName,
	target: FleetMemberName,
	cause: SwitchCause,
	reason: NonEmptyReason,
	sealedAtMs: EpochMs,
}) {}

export class FleetSwitchCompleted extends Domain.Event("FleetSwitchCompleted", {
	previousActive: FleetMemberName,
	active: FleetMemberName,
	epoch: EpochNumber,
	completedAtMs: EpochMs,
}) {}

export class FleetSwitchAborted extends Domain.Event("FleetSwitchAborted", {
	active: FleetMemberName,
	abortedTarget: FleetMemberName,
	reason: NonEmptyReason,
}) {}

export class FleetFailoverPromoted extends Domain.Event(
	"FleetFailoverPromoted",
	{
		failedMember: FleetMemberName,
		active: FleetMemberName,
		epoch: EpochNumber,
		lossWindowMs: Schema.NullOr(NonNegativeMs),
		reason: NonEmptyReason,
		promotedAtMs: EpochMs,
	},
) {}

export class InitializeFleetAssignment extends Domain.Command(
	"InitializeFleetAssignment",
	{
		target: FleetId,
		input: {
			active: FleetMemberName,
			members: Schema.Array(FleetMemberName),
			marks: RoutingHysteresisMarks,
			nowMs: EpochMs,
		},
		events: [FleetAssignmentInitialized],
		rejects: [FleetAlreadyInitialized, FleetMemberNotInRoster],
	},
	{
		description:
			"Initialize a one-active fleet assignment with validated non-flapping hysteresis marks.",
	},
) {}

export class ProposeBudgetSwitch extends Domain.Command(
	"ProposeBudgetSwitch",
	{
		target: FleetId,
		input: {
			target: FleetMemberName,
			cause: SwitchCause,
			reason: NonEmptyReason,
			observedUtilization: Schema.NullOr(UnitFraction),
			nowMs: EpochMs,
		},
		events: [FleetSwitchSealed],
		rejects: [
			FleetNotInitialized,
			FleetSwitchAlreadyInFlight,
			SwitchTargetMatchesActive,
			MinimumDwellNotReached,
			FleetMemberNotInRoster,
			SwitchUtilizationThresholdNotReached,
		],
	},
	{
		description:
			"Seal a planned switch to a distinct standby, enforcing minimum dwell on preference moves.",
	},
) {}

export class CompleteSealedSwitch extends Domain.Command(
	"CompleteSealedSwitch",
	{
		target: FleetId,
		input: {
			completedAtMs: EpochMs,
		},
		events: [FleetSwitchCompleted],
		rejects: [NoSwitchInFlight],
	},
	{
		description:
			"Complete an in-flight sealed switch and promote the sealed target to active.",
	},
) {}

export class AbortSealedSwitch extends Domain.Command(
	"AbortSealedSwitch",
	{
		target: FleetId,
		input: {
			reason: NonEmptyReason,
		},
		events: [FleetSwitchAborted],
		rejects: [NoSwitchInFlight],
	},
	{
		description:
			"Abort an in-flight sealed switch and keep the current active member.",
	},
) {}

export class PromoteFailoverStandby extends Domain.Command(
	"PromoteFailoverStandby",
	{
		target: FleetId,
		input: {
			target: FleetMemberName,
			failingForMs: NonNegativeMs,
			lossWindowMs: Schema.NullOr(NonNegativeMs),
			reason: NonEmptyReason,
			nowMs: EpochMs,
		},
		events: [FleetFailoverPromoted],
		rejects: [
			FleetNotInitialized,
			FleetSwitchAlreadyInFlight,
			SwitchTargetMatchesActive,
			FailoverThresholdNotReached,
			FleetMemberNotInRoster,
		],
	},
	{
		description:
			"Promote a distinct reachable standby once active member failure duration meets failoverAfterMs.",
	},
) {}

const rosterIncludes = (
	members: readonly FleetMemberName[],
	member: FleetMemberName,
): boolean => members.some((entry) => entry === member);

export const UnassignedFleetState = Schema.TaggedStruct("Unassigned", {});

export const ActiveFleetState = Schema.TaggedStruct("Active", {
	epoch: EpochNumber,
	active: FleetMemberName,
	members: Schema.Array(FleetMemberName),
	marks: RoutingHysteresisMarks,
	decidedAtMs: EpochMs,
});

export const SwitchSealedFleetState = Schema.TaggedStruct("SwitchSealed", {
	epoch: EpochNumber,
	active: FleetMemberName,
	target: FleetMemberName,
	members: Schema.Array(FleetMemberName),
	marks: RoutingHysteresisMarks,
	decidedAtMs: EpochMs,
	sealedAtMs: EpochMs,
	reason: NonEmptyReason,
});

export const FleetAssignmentState = Schema.Union([
	UnassignedFleetState,
	ActiveFleetState,
	SwitchSealedFleetState,
]);
export type FleetAssignmentState = typeof FleetAssignmentState.Type;

const EPOCH_ONE = decodeEpochNumber(1);

const INITIAL_FLEET_STATE: FleetAssignmentState = {
	_tag: "Unassigned",
};

export class FleetAssignment extends Domain.Aggregate("FleetAssignment", {
	id: FleetId,
	state: FleetAssignmentState,
	initial: INITIAL_FLEET_STATE,
	commands: [
		InitializeFleetAssignment,
		ProposeBudgetSwitch,
		CompleteSealedSwitch,
		AbortSealedSwitch,
		PromoteFailoverStandby,
	],
	decide: {
		InitializeFleetAssignment: (state, cmd) => {
			if (state._tag !== "Unassigned") {
				return new FleetAlreadyInitialized({
					active: state.active,
					epoch: state.epoch,
				});
			}
			if (!rosterIncludes(cmd.members, cmd.active)) {
				return new FleetMemberNotInRoster({ member: cmd.active });
			}
			return [
				new FleetAssignmentInitialized({
					active: cmd.active,
					members: cmd.members,
					marks: cmd.marks,
					epoch: EPOCH_ONE,
					decidedAtMs: cmd.nowMs,
				}),
			];
		},
		ProposeBudgetSwitch: (state, cmd, { id }) => {
			if (state._tag === "Unassigned") {
				return new FleetNotInitialized({ fleetId: id });
			}
			if (state._tag === "SwitchSealed") {
				return new FleetSwitchAlreadyInFlight({
					active: state.active,
					target: state.target,
				});
			}
			if (!rosterIncludes(state.members, cmd.target)) {
				return new FleetMemberNotInRoster({ member: cmd.target });
			}
			if (cmd.target === state.active) {
				return new SwitchTargetMatchesActive({ member: cmd.target });
			}
			if (cmd.cause === "exhaustion") {
				if (
					cmd.observedUtilization === null ||
					cmd.observedUtilization < state.marks.switchAt
				) {
					return new SwitchUtilizationThresholdNotReached({
						observedUtilization: cmd.observedUtilization,
						requiredUtilization: state.marks.switchAt,
					});
				}
			}
			if (cmd.cause === "budget-cap") {
				if (
					cmd.observedUtilization === null ||
					cmd.observedUtilization >= state.marks.switchBackBelow
				) {
					return new SwitchUtilizationThresholdNotReached({
						observedUtilization: cmd.observedUtilization,
						requiredUtilization: state.marks.switchBackBelow,
					});
				}
			}
			if (
				cmd.cause === "preference" &&
				cmd.nowMs < state.decidedAtMs + state.marks.minDwellMs
			) {
				return new MinimumDwellNotReached({
					nextAllowedAtMs: decodeEpochMs(
						state.decidedAtMs + state.marks.minDwellMs,
					),
					nowMs: cmd.nowMs,
				});
			}
			return [
				new FleetSwitchSealed({
					from: state.active,
					target: cmd.target,
					cause: cmd.cause,
					reason: cmd.reason,
					sealedAtMs: cmd.nowMs,
				}),
			];
		},
		CompleteSealedSwitch: (state, cmd, { id }) => {
			if (state._tag !== "SwitchSealed") {
				return new NoSwitchInFlight({ fleetId: id });
			}
			return [
				new FleetSwitchCompleted({
					previousActive: state.active,
					active: state.target,
					epoch: decodeEpochNumber(state.epoch + 1),
					completedAtMs: cmd.completedAtMs,
				}),
			];
		},
		AbortSealedSwitch: (state, cmd, { id }) => {
			if (state._tag !== "SwitchSealed") {
				return new NoSwitchInFlight({ fleetId: id });
			}
			return [
				new FleetSwitchAborted({
					active: state.active,
					abortedTarget: state.target,
					reason: cmd.reason,
				}),
			];
		},
		PromoteFailoverStandby: (state, cmd, { id }) => {
			if (state._tag === "Unassigned") {
				return new FleetNotInitialized({ fleetId: id });
			}
			if (state._tag === "SwitchSealed") {
				return new FleetSwitchAlreadyInFlight({
					active: state.active,
					target: state.target,
				});
			}
			if (!rosterIncludes(state.members, cmd.target)) {
				return new FleetMemberNotInRoster({ member: cmd.target });
			}
			if (cmd.target === state.active) {
				return new SwitchTargetMatchesActive({ member: cmd.target });
			}
			if (cmd.failingForMs < state.marks.failoverAfterMs) {
				return new FailoverThresholdNotReached({
					failingForMs: cmd.failingForMs,
					failoverAfterMs: state.marks.failoverAfterMs,
				});
			}
			return [
				new FleetFailoverPromoted({
					failedMember: state.active,
					active: cmd.target,
					epoch: decodeEpochNumber(state.epoch + 1),
					lossWindowMs: cmd.lossWindowMs,
					reason: cmd.reason,
					promotedAtMs: cmd.nowMs,
				}),
			];
		},
	},
	evolve: {
		FleetAssignmentInitialized: (_state, event) => ({
			_tag: "Active" as const,
			epoch: event.epoch,
			active: event.active,
			members: event.members,
			marks: event.marks,
			decidedAtMs: event.decidedAtMs,
		}),
		FleetSwitchSealed: (state, event) => {
			if (state._tag !== "Active") {
				return state;
			}
			return {
				_tag: "SwitchSealed" as const,
				epoch: state.epoch,
				active: state.active,
				target: event.target,
				members: state.members,
				marks: state.marks,
				decidedAtMs: state.decidedAtMs,
				sealedAtMs: event.sealedAtMs,
				reason: event.reason,
			};
		},
		FleetSwitchCompleted: (state, event) => {
			if (state._tag !== "SwitchSealed") {
				return state;
			}
			return {
				_tag: "Active" as const,
				epoch: event.epoch,
				active: event.active,
				members: state.members,
				marks: state.marks,
				decidedAtMs: event.completedAtMs,
			};
		},
		FleetSwitchAborted: (state) => {
			if (state._tag !== "SwitchSealed") {
				return state;
			}
			return {
				_tag: "Active" as const,
				epoch: state.epoch,
				active: state.active,
				members: state.members,
				marks: state.marks,
				decidedAtMs: state.decidedAtMs,
			};
		},
		FleetFailoverPromoted: (state, event) => {
			if (state._tag !== "Active") {
				return state;
			}
			return {
				_tag: "Active" as const,
				epoch: event.epoch,
				active: event.active,
				members: state.members,
				marks: state.marks,
				decidedAtMs: event.promotedAtMs,
			};
		},
	},
}) {}
