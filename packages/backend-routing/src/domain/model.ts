import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { FleetAssignment } from "./FleetAssignment.aggregate.js";
import {
	EpochMs,
	EpochNumber,
	FleetMemberName,
	NonEmptyReason,
} from "./ids.js";

export const UnassignedFleetView = Schema.TaggedStruct("Unassigned", {});

export const ActiveFleetView = Schema.TaggedStruct("Active", {
	epoch: EpochNumber,
	active: FleetMemberName,
	decidedAtMs: EpochMs,
});

export const SwitchSealedFleetView = Schema.TaggedStruct("SwitchSealed", {
	epoch: EpochNumber,
	active: FleetMemberName,
	target: FleetMemberName,
	decidedAtMs: EpochMs,
	sealedAtMs: EpochMs,
	reason: NonEmptyReason,
});

export const FleetAssignmentViewState = Schema.Union([
	UnassignedFleetView,
	ActiveFleetView,
	SwitchSealedFleetView,
]);
export type FleetAssignmentViewState = typeof FleetAssignmentViewState.Type;

const INITIAL_VIEW_STATE: FleetAssignmentViewState = {
	_tag: "Unassigned",
};

export class FleetAssignmentView extends Domain.View("FleetAssignmentView", {
	from: [FleetAssignment],
	key: FleetAssignment,
	state: FleetAssignmentViewState,
	initial: INITIAL_VIEW_STATE,
	evolve: {
		FleetAssignmentInitialized: (_state, event) => ({
			_tag: "Active" as const,
			epoch: event.epoch,
			active: event.active,
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
				decidedAtMs: state.decidedAtMs,
				sealedAtMs: event.sealedAtMs,
				reason: event.reason,
			};
		},
		FleetSwitchCompleted: (_state, event) => ({
			_tag: "Active" as const,
			epoch: event.epoch,
			active: event.active,
			decidedAtMs: event.completedAtMs,
		}),
		FleetSwitchAborted: (state) => {
			if (state._tag !== "SwitchSealed") {
				return state;
			}
			return {
				_tag: "Active" as const,
				epoch: state.epoch,
				active: state.active,
				decidedAtMs: state.decidedAtMs,
			};
		},
		FleetFailoverPromoted: (_state, event) => ({
			_tag: "Active" as const,
			epoch: event.epoch,
			active: event.active,
			decidedAtMs: event.promotedAtMs,
		}),
	},
}) {}

export class BackendRouting extends Domain.Model(
	"BackendRouting",
	{
		aggregates: [FleetAssignment],
		views: [FleetAssignmentView],
	},
	{
		description:
			"One-active fleet routing lifecycle with non-flapping hysteresis marks, discriminated allowances, and sealed switch coordination.",
	},
) {}

export class BackendRoutingApi extends Domain.Api(
	"BackendRoutingApi",
	{
		model: BackendRouting,
		commands: [
			"InitializeFleetAssignment",
			"ProposeBudgetSwitch",
			"CompleteSealedSwitch",
			"AbortSealedSwitch",
			"PromoteFailoverStandby",
		],
		views: ["FleetAssignmentView"],
	},
	{
		description:
			"Control API for one-active fleet budget switching and failover promotion.",
	},
) {}
