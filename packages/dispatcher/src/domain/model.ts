import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { DispatchAccount } from "./DispatchAccount.aggregate.js";
import {
	decodeNonNegativeMicros,
	decodeNonNegativeUnits,
	NonNegativeMicros,
	NonNegativeSlots,
	NonNegativeUnits,
} from "./ids.js";

export const UnconfiguredDispatchAccountView = Schema.TaggedStruct(
	"Unconfigured",
	{},
);

export const ConfiguredDispatchAccountView = Schema.TaggedStruct("Configured", {
	freeHeadroom: NonNegativeUnits,
	rateHeadroom: NonNegativeUnits,
	concurrencyHeadroom: NonNegativeSlots,
	budgetCapMicros: Schema.NullOr(NonNegativeMicros),
	spentMicros: NonNegativeMicros,
	heldMicros: NonNegativeMicros,
	availableBudgetMicros: Schema.NullOr(NonNegativeMicros),
	activeReservationCount: NonNegativeUnits,
	overrunSeen: Schema.Boolean,
});

export const DispatchAccountViewState = Schema.Union([
	UnconfiguredDispatchAccountView,
	ConfiguredDispatchAccountView,
]);
export type DispatchAccountViewState = typeof DispatchAccountViewState.Type;

const ZERO_MICROS = decodeNonNegativeMicros(0);
const ZERO_UNITS = decodeNonNegativeUnits(0);

const INITIAL_VIEW_STATE: DispatchAccountViewState = {
	_tag: "Unconfigured",
};

function computeAvailableBudget(
	budgetCapMicros: NonNegativeMicros | null,
	spentMicros: NonNegativeMicros,
	heldMicros: NonNegativeMicros,
): NonNegativeMicros | null {
	if (budgetCapMicros === null) {
		return null;
	}
	return decodeNonNegativeMicros(
		Math.max(0, budgetCapMicros - spentMicros - heldMicros),
	);
}

export class DispatchAccountView extends Domain.View("DispatchAccountView", {
	from: [DispatchAccount],
	key: DispatchAccount,
	state: DispatchAccountViewState,
	initial: INITIAL_VIEW_STATE,
	evolve: {
		DispatchAccountConfigured: (state, event) => {
			const spentMicros =
				state._tag === "Configured" ? state.spentMicros : ZERO_MICROS;
			const heldMicros =
				state._tag === "Configured" ? state.heldMicros : ZERO_MICROS;
			return {
				_tag: "Configured" as const,
				freeHeadroom: event.freeHeadroom,
				rateHeadroom: event.rateHeadroom,
				concurrencyHeadroom: event.concurrencyHeadroom,
				budgetCapMicros: event.budgetCapMicros,
				spentMicros,
				heldMicros,
				availableBudgetMicros: computeAvailableBudget(
					event.budgetCapMicros,
					spentMicros,
					heldMicros,
				),
				activeReservationCount:
					state._tag === "Configured"
						? state.activeReservationCount
						: ZERO_UNITS,
				overrunSeen: state._tag === "Configured" ? state.overrunSeen : false,
			};
		},
		DispatchReserved: (state, event) => {
			if (state._tag !== "Configured") {
				return state;
			}
			return {
				...state,
				freeHeadroom: event.freeHeadroomAfter,
				rateHeadroom: event.rateHeadroomAfter,
				concurrencyHeadroom: event.concurrencyHeadroomAfter,
				heldMicros: event.heldMicrosAfter,
				availableBudgetMicros: computeAvailableBudget(
					state.budgetCapMicros,
					state.spentMicros,
					event.heldMicrosAfter,
				),
				activeReservationCount: decodeNonNegativeUnits(
					state.activeReservationCount + 1,
				),
			};
		},
		DispatchReservationStarted: (state) => state,
		DispatchReservationReleased: (state, event) => {
			if (state._tag !== "Configured") {
				return state;
			}
			return {
				...state,
				freeHeadroom: event.freeHeadroomAfter,
				rateHeadroom: event.rateHeadroomAfter,
				concurrencyHeadroom: event.concurrencyHeadroomAfter,
				heldMicros: event.heldMicrosAfter,
				availableBudgetMicros: computeAvailableBudget(
					state.budgetCapMicros,
					state.spentMicros,
					event.heldMicrosAfter,
				),
				activeReservationCount: decodeNonNegativeUnits(
					Math.max(0, state.activeReservationCount - 1),
				),
			};
		},
		DispatchReservationConfirmed: (state, event) => {
			if (state._tag !== "Configured") {
				return state;
			}
			return {
				...state,
				concurrencyHeadroom: event.concurrencyHeadroomAfter,
				spentMicros: event.spentMicrosAfter,
				heldMicros: event.heldMicrosAfter,
				availableBudgetMicros: computeAvailableBudget(
					state.budgetCapMicros,
					event.spentMicrosAfter,
					event.heldMicrosAfter,
				),
				activeReservationCount: decodeNonNegativeUnits(
					Math.max(0, state.activeReservationCount - 1),
				),
				overrunSeen: state.overrunSeen || event.overrun,
			};
		},
		PendingReservationsExpired: (state, event) => {
			if (state._tag !== "Configured") {
				return state;
			}
			return {
				...state,
				freeHeadroom: event.freeHeadroomAfter,
				rateHeadroom: event.rateHeadroomAfter,
				concurrencyHeadroom: event.concurrencyHeadroomAfter,
				heldMicros: event.heldMicrosAfter,
				availableBudgetMicros: computeAvailableBudget(
					state.budgetCapMicros,
					state.spentMicros,
					event.heldMicrosAfter,
				),
				activeReservationCount: decodeNonNegativeUnits(
					Math.max(
						0,
						state.activeReservationCount - event.expiredReservationIds.length,
					),
				),
			};
		},
	},
}) {}

export class DispatchRouting extends Domain.Model(
	"DispatchRouting",
	{
		aggregates: [DispatchAccount],
		views: [DispatchAccountView],
	},
	{
		description:
			"Category-scoped, exact-micro-dollar dispatch selection and reservation accounting with statically enforced state transitions.",
	},
) {}

export class DispatchRoutingApi extends Domain.Api(
	"DispatchRoutingApi",
	{
		model: DispatchRouting,
		commands: [
			"ConfigureDispatchAccount",
			"ReserveDispatch",
			"StartReservation",
			"ReleaseReservation",
			"ConfirmReservation",
			"ExpirePendingReservations",
		],
		views: ["DispatchAccountView"],
	},
	{
		description:
			"Control API for category-scoped dispatch budget admission and reservation lifecycle.",
	},
) {}
