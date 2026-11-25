import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
	ActiveReservationHold,
	decodeActiveReservationHold,
	decodeNonNegativeMicros,
	decodeNonNegativeSlots,
	decodeNonNegativeUnits,
	EpochMs,
	NonEmptyReason,
	NonNegativeMicros,
	NonNegativeSlots,
	NonNegativeUnits,
	PositiveUnits,
	ReservationId,
	ReservationStatusTag,
	ScopedAccountId,
	UsageEvidenceRef,
} from "./ids.js";

export class AccountNotConfigured extends Domain.Rejection(
	"AccountNotConfigured",
	{
		accountId: ScopedAccountId,
	},
) {}

export class AccountHasActiveReservations extends Domain.Rejection(
	"AccountHasActiveReservations",
	{
		accountId: ScopedAccountId,
		activeCount: NonNegativeUnits,
	},
) {}

export class BudgetCapBelowLiabilities extends Domain.Rejection(
	"BudgetCapBelowLiabilities",
	{
		spentMicros: NonNegativeMicros,
		heldMicros: NonNegativeMicros,
		requestedCapMicros: NonNegativeMicros,
	},
) {}

export class DuplicateReservation extends Domain.Rejection(
	"DuplicateReservation",
	{
		reservationId: ReservationId,
	},
) {}

export class UnknownReservation extends Domain.Rejection("UnknownReservation", {
	reservationId: ReservationId,
}) {}

export class InsufficientHeadroom extends Domain.Rejection(
	"InsufficientHeadroom",
	{
		dimension: Schema.Literals(["rate", "concurrency"]),
		requested: PositiveUnits,
		available: NonNegativeUnits,
	},
) {}

export class BudgetCapExceeded extends Domain.Rejection("BudgetCapExceeded", {
	spentMicros: NonNegativeMicros,
	heldMicros: NonNegativeMicros,
	requiredMicros: NonNegativeMicros,
	budgetCapMicros: NonNegativeMicros,
}) {}

export class ReservationNotStartable extends Domain.Rejection(
	"ReservationNotStartable",
	{
		reservationId: ReservationId,
		status: ReservationStatusTag,
	},
) {}

export class ReservationNotReleasable extends Domain.Rejection(
	"ReservationNotReleasable",
	{
		reservationId: ReservationId,
		status: ReservationStatusTag,
	},
) {}

export class ReservationNotConfirmable extends Domain.Rejection(
	"ReservationNotConfirmable",
	{
		reservationId: ReservationId,
		status: ReservationStatusTag,
	},
) {}

export class UsageEvidenceRequired extends Domain.Rejection(
	"UsageEvidenceRequired",
	{
		reservationId: ReservationId,
	},
) {}

export class SettlementExceedsHold extends Domain.Rejection(
	"SettlementExceedsHold",
	{
		reservationId: ReservationId,
		reservedMicros: NonNegativeMicros,
		settledMicros: NonNegativeMicros,
	},
) {}

export class DispatchOverrunReconciliationRequired extends Domain.Rejection(
	"DispatchOverrunReconciliationRequired",
	{
		accountId: ScopedAccountId,
	},
) {}

export class DispatchAccountConfigured extends Domain.Event(
	"DispatchAccountConfigured",
	{
		listUnitMicros: NonNegativeMicros,
		freeHeadroom: NonNegativeUnits,
		rateHeadroom: NonNegativeUnits,
		concurrencyHeadroom: NonNegativeSlots,
		budgetCapMicros: Schema.NullOr(NonNegativeMicros),
	},
) {}

export class DispatchReserved extends Domain.Event("DispatchReserved", {
	reservationId: ReservationId,
	hold: ActiveReservationHold,
	expiresAtMs: Schema.NullOr(EpochMs),
	freeHeadroomAfter: NonNegativeUnits,
	rateHeadroomAfter: NonNegativeUnits,
	concurrencyHeadroomAfter: NonNegativeSlots,
	heldMicrosAfter: NonNegativeMicros,
}) {}

export class DispatchReservationStarted extends Domain.Event(
	"DispatchReservationStarted",
	{
		reservationId: ReservationId,
	},
) {}

export class DispatchReservationReleased extends Domain.Event(
	"DispatchReservationReleased",
	{
		reservationId: ReservationId,
		reason: NonEmptyReason,
		freeHeadroomAfter: NonNegativeUnits,
		rateHeadroomAfter: NonNegativeUnits,
		concurrencyHeadroomAfter: NonNegativeSlots,
		heldMicrosAfter: NonNegativeMicros,
	},
) {}

export class DispatchReservationConfirmed extends Domain.Event(
	"DispatchReservationConfirmed",
	{
		reservationId: ReservationId,
		settledMicros: NonNegativeMicros,
		overrun: Schema.Boolean,
		usageEvidenceRef: Schema.NullOr(UsageEvidenceRef),
		concurrencyHeadroomAfter: NonNegativeSlots,
		spentMicrosAfter: NonNegativeMicros,
		heldMicrosAfter: NonNegativeMicros,
	},
) {}

export class PendingReservationsExpired extends Domain.Event(
	"PendingReservationsExpired",
	{
		nowMs: EpochMs,
		expiredReservationIds: Schema.NonEmptyArray(ReservationId),
		freeHeadroomAfter: NonNegativeUnits,
		rateHeadroomAfter: NonNegativeUnits,
		concurrencyHeadroomAfter: NonNegativeSlots,
		heldMicrosAfter: NonNegativeMicros,
	},
) {}

export class ConfigureDispatchAccount extends Domain.Command(
	"ConfigureDispatchAccount",
	{
		target: ScopedAccountId,
		input: {
			listUnitMicros: NonNegativeMicros,
			freeHeadroom: NonNegativeUnits,
			rateHeadroom: NonNegativeUnits,
			concurrencyHeadroom: NonNegativeSlots,
			budgetCapMicros: Schema.NullOr(NonNegativeMicros),
		},
		events: [DispatchAccountConfigured],
		rejects: [AccountHasActiveReservations, BudgetCapBelowLiabilities],
	},
	{
		description:
			"Configure capacity, free credits, unit pricing, and hard budget ceiling for a category-scoped provider account.",
	},
) {}

export class ReserveDispatch extends Domain.Command(
	"ReserveDispatch",
	{
		target: ScopedAccountId,
		input: {
			reservationId: ReservationId,
			units: PositiveUnits,
			estimatedMicros: NonNegativeMicros,
			expiresAtMs: Schema.NullOr(EpochMs),
		},
		events: [DispatchReserved],
		rejects: [
			AccountNotConfigured,
			DispatchOverrunReconciliationRequired,
			DuplicateReservation,
			InsufficientHeadroom,
			BudgetCapExceeded,
		],
	},
	{
		description:
			"Atomically reserve free headroom, rate, concurrency, and hard-budget hold on a category-scoped provider account.",
	},
) {}

export class StartReservation extends Domain.Command(
	"StartReservation",
	{
		target: ScopedAccountId,
		input: {
			reservationId: ReservationId,
		},
		events: [DispatchReservationStarted],
		rejects: [
			AccountNotConfigured,
			UnknownReservation,
			ReservationNotStartable,
		],
	},
	{
		description:
			"Transition a pending reservation to running so it can no longer be silently released without settlement evidence.",
	},
) {}

export class ReleaseReservation extends Domain.Command(
	"ReleaseReservation",
	{
		target: ScopedAccountId,
		input: {
			reservationId: ReservationId,
			reason: NonEmptyReason,
		},
		events: [DispatchReservationReleased],
		rejects: [
			AccountNotConfigured,
			UnknownReservation,
			ReservationNotReleasable,
		],
	},
	{
		description:
			"Release a pending reservation once, restoring its bounded hold and clearing it from active liabilities.",
	},
) {}

export class ConfirmReservation extends Domain.Command(
	"ConfirmReservation",
	{
		target: ScopedAccountId,
		input: {
			reservationId: ReservationId,
			settledMicros: NonNegativeMicros,
			usageEvidenceRef: Schema.NullOr(UsageEvidenceRef),
		},
		events: [DispatchReservationConfirmed],
		rejects: [
			AccountNotConfigured,
			UnknownReservation,
			ReservationNotConfirmable,
			UsageEvidenceRequired,
			SettlementExceedsHold,
		],
	},
	{
		description:
			"Settle a pending or running reservation into realized spend, requiring usage evidence for running work.",
	},
) {}

export class ExpirePendingReservations extends Domain.Command(
	"ExpirePendingReservations",
	{
		target: ScopedAccountId,
		input: {
			nowMs: EpochMs,
		},
		events: [PendingReservationsExpired],
		rejects: [AccountNotConfigured],
	},
	{
		description:
			"Atomically expire all pending reservations whose deadline has passed at or before nowMs.",
	},
) {}

export const PendingReservation = Schema.TaggedStruct("Pending", {
	reservationId: ReservationId,
	hold: ActiveReservationHold,
	expiresAtMs: Schema.NullOr(EpochMs),
});

export const RunningReservation = Schema.TaggedStruct("Running", {
	reservationId: ReservationId,
	hold: ActiveReservationHold,
});

export const ConfirmedReservation = Schema.TaggedStruct("Confirmed", {
	reservationId: ReservationId,
	settledMicros: NonNegativeMicros,
	overrun: Schema.Boolean,
	usageEvidenceRef: Schema.NullOr(UsageEvidenceRef),
});

export const ReleasedReservation = Schema.TaggedStruct("Released", {
	reservationId: ReservationId,
	reason: NonEmptyReason,
});

export const ExpiredReservation = Schema.TaggedStruct("Expired", {
	reservationId: ReservationId,
	expiredAtMs: EpochMs,
});

export const ReservationEntry = Schema.Union([
	PendingReservation,
	RunningReservation,
	ConfirmedReservation,
	ReleasedReservation,
	ExpiredReservation,
]);
export type ReservationEntry = typeof ReservationEntry.Type;

export const UnconfiguredDispatchAccount = Schema.TaggedStruct(
	"Unconfigured",
	{},
);

export const ConfiguredDispatchAccount = Schema.TaggedStruct("Configured", {
	listUnitMicros: NonNegativeMicros,
	freeHeadroom: NonNegativeUnits,
	rateHeadroom: NonNegativeUnits,
	concurrencyHeadroom: NonNegativeSlots,
	budgetCapMicros: Schema.NullOr(NonNegativeMicros),
	spentMicros: NonNegativeMicros,
	heldMicros: NonNegativeMicros,
	overrunSeen: Schema.Boolean,
	reservations: Schema.Array(ReservationEntry),
});

export const DispatchAccountState = Schema.Union([
	UnconfiguredDispatchAccount,
	ConfiguredDispatchAccount,
]);
export type DispatchAccountState = typeof DispatchAccountState.Type;

const ZERO_MICROS = decodeNonNegativeMicros(0);
const ONE_SLOT = decodeNonNegativeSlots(1);
const ONE_UNIT = decodeNonNegativeUnits(1);

const INITIAL_DISPATCH_ACCOUNT_STATE: DispatchAccountState = {
	_tag: "Unconfigured",
};

export class DispatchAccount extends Domain.Aggregate("DispatchAccount", {
	id: ScopedAccountId,
	state: DispatchAccountState,
	initial: INITIAL_DISPATCH_ACCOUNT_STATE,
	commands: [
		ConfigureDispatchAccount,
		ReserveDispatch,
		StartReservation,
		ReleaseReservation,
		ConfirmReservation,
		ExpirePendingReservations,
	],
	decide: {
		ConfigureDispatchAccount: (state, cmd, { id }) => {
			if (state._tag === "Configured") {
				const activeCount = state.reservations.filter(
					(entry) => entry._tag === "Pending" || entry._tag === "Running",
				).length;
				if (activeCount > 0) {
					return new AccountHasActiveReservations({
						accountId: id,
						activeCount: decodeNonNegativeUnits(activeCount),
					});
				}
				if (
					cmd.budgetCapMicros !== null &&
					cmd.budgetCapMicros < state.spentMicros + state.heldMicros
				) {
					return new BudgetCapBelowLiabilities({
						spentMicros: state.spentMicros,
						heldMicros: state.heldMicros,
						requestedCapMicros: cmd.budgetCapMicros,
					});
				}
			}
			return [
				new DispatchAccountConfigured({
					listUnitMicros: cmd.listUnitMicros,
					freeHeadroom: cmd.freeHeadroom,
					rateHeadroom: cmd.rateHeadroom,
					concurrencyHeadroom: cmd.concurrencyHeadroom,
					budgetCapMicros: cmd.budgetCapMicros,
				}),
			];
		},
		ReserveDispatch: (state, cmd, { id }) => {
			if (state._tag === "Unconfigured") {
				return new AccountNotConfigured({ accountId: id });
			}
			if (state.overrunSeen) {
				return new DispatchOverrunReconciliationRequired({ accountId: id });
			}
			if (
				state.reservations.some(
					(entry) => entry.reservationId === cmd.reservationId,
				)
			) {
				return new DuplicateReservation({ reservationId: cmd.reservationId });
			}
			if (state.rateHeadroom < cmd.units) {
				return new InsufficientHeadroom({
					dimension: "rate",
					requested: cmd.units,
					available: state.rateHeadroom,
				});
			}
			if (state.concurrencyHeadroom < ONE_SLOT) {
				return new InsufficientHeadroom({
					dimension: "concurrency",
					requested: decodePositiveUnitsOne(),
					available: decodeNonNegativeUnits(state.concurrencyHeadroom),
				});
			}

			const freeUnits = Math.min(state.freeHeadroom, cmd.units);
			const paidUnits = cmd.units - freeUnits;
			const computedMicros = paidUnits * state.listUnitMicros;
			const requiredMicros = Math.max(computedMicros, cmd.estimatedMicros);

			if (
				state.budgetCapMicros !== null &&
				state.spentMicros + state.heldMicros + requiredMicros >
					state.budgetCapMicros
			) {
				return new BudgetCapExceeded({
					spentMicros: state.spentMicros,
					heldMicros: state.heldMicros,
					requiredMicros: decodeNonNegativeMicros(requiredMicros),
					budgetCapMicros: state.budgetCapMicros,
				});
			}

			const hold = decodeActiveReservationHold({
				units: cmd.units,
				freeUnits: decodeNonNegativeUnits(freeUnits),
				paidUnits: decodeNonNegativeUnits(paidUnits),
				reservedMicros: decodeNonNegativeMicros(requiredMicros),
				concurrencySlots: ONE_SLOT,
			});

			return [
				new DispatchReserved({
					reservationId: cmd.reservationId,
					hold,
					expiresAtMs: cmd.expiresAtMs,
					freeHeadroomAfter: decodeNonNegativeUnits(
						state.freeHeadroom - freeUnits,
					),
					rateHeadroomAfter: decodeNonNegativeUnits(
						state.rateHeadroom - cmd.units,
					),
					concurrencyHeadroomAfter: decodeNonNegativeSlots(
						state.concurrencyHeadroom - ONE_SLOT,
					),
					heldMicrosAfter: decodeNonNegativeMicros(
						state.heldMicros + hold.reservedMicros,
					),
				}),
			];
		},
		StartReservation: (state, cmd, { id }) => {
			if (state._tag === "Unconfigured") {
				return new AccountNotConfigured({ accountId: id });
			}
			const existing = state.reservations.find(
				(entry) => entry.reservationId === cmd.reservationId,
			);
			if (existing === undefined) {
				return new UnknownReservation({ reservationId: cmd.reservationId });
			}
			if (existing._tag === "Running") {
				return [];
			}
			if (existing._tag !== "Pending") {
				return new ReservationNotStartable({
					reservationId: cmd.reservationId,
					status: existing._tag,
				});
			}
			return [
				new DispatchReservationStarted({
					reservationId: cmd.reservationId,
				}),
			];
		},
		ReleaseReservation: (state, cmd, { id }) => {
			if (state._tag === "Unconfigured") {
				return new AccountNotConfigured({ accountId: id });
			}
			const existing = state.reservations.find(
				(entry) => entry.reservationId === cmd.reservationId,
			);
			if (existing === undefined) {
				return new UnknownReservation({ reservationId: cmd.reservationId });
			}
			if (existing._tag !== "Pending") {
				return new ReservationNotReleasable({
					reservationId: cmd.reservationId,
					status: existing._tag,
				});
			}
			const { hold } = existing;
			return [
				new DispatchReservationReleased({
					reservationId: cmd.reservationId,
					reason: cmd.reason,
					freeHeadroomAfter: decodeNonNegativeUnits(
						state.freeHeadroom + hold.freeUnits,
					),
					rateHeadroomAfter: decodeNonNegativeUnits(
						state.rateHeadroom + hold.units,
					),
					concurrencyHeadroomAfter: decodeNonNegativeSlots(
						state.concurrencyHeadroom + hold.concurrencySlots,
					),
					heldMicrosAfter: decodeNonNegativeMicros(
						Math.max(0, state.heldMicros - hold.reservedMicros),
					),
				}),
			];
		},
		ConfirmReservation: (state, cmd, { id }) => {
			if (state._tag === "Unconfigured") {
				return new AccountNotConfigured({ accountId: id });
			}
			const existing = state.reservations.find(
				(entry) => entry.reservationId === cmd.reservationId,
			);
			if (existing === undefined) {
				return new UnknownReservation({ reservationId: cmd.reservationId });
			}
			if (existing._tag !== "Pending" && existing._tag !== "Running") {
				return new ReservationNotConfirmable({
					reservationId: cmd.reservationId,
					status: existing._tag,
				});
			}
			if (cmd.usageEvidenceRef === null) {
				return new UsageEvidenceRequired({ reservationId: cmd.reservationId });
			}
			const { hold } = existing;
			if (cmd.settledMicros > hold.reservedMicros) {
				return new SettlementExceedsHold({
					reservationId: cmd.reservationId,
					reservedMicros: hold.reservedMicros,
					settledMicros: cmd.settledMicros,
				});
			}
			return [
				new DispatchReservationConfirmed({
					reservationId: cmd.reservationId,
					settledMicros: cmd.settledMicros,
					overrun: cmd.settledMicros > hold.reservedMicros,
					usageEvidenceRef: cmd.usageEvidenceRef,
					concurrencyHeadroomAfter: decodeNonNegativeSlots(
						state.concurrencyHeadroom + hold.concurrencySlots,
					),
					spentMicrosAfter: decodeNonNegativeMicros(
						state.spentMicros + cmd.settledMicros,
					),
					heldMicrosAfter: decodeNonNegativeMicros(
						Math.max(0, state.heldMicros - hold.reservedMicros),
					),
				}),
			];
		},
		ExpirePendingReservations: (state, cmd, { id }) => {
			if (state._tag === "Unconfigured") {
				return new AccountNotConfigured({ accountId: id });
			}
			const due = state.reservations.filter(
				(entry) =>
					entry._tag === "Pending" &&
					entry.expiresAtMs !== null &&
					entry.expiresAtMs <= cmd.nowMs,
			);
			const [first, ...rest] = due;
			if (first === undefined) {
				return [];
			}
			let restoredFree = 0;
			let restoredRate = 0;
			let restoredSlots = 0;
			let releasedMicros = 0;
			for (const entry of due) {
				if (entry._tag !== "Pending") {
					continue;
				}
				restoredFree += entry.hold.freeUnits;
				restoredRate += entry.hold.units;
				restoredSlots += entry.hold.concurrencySlots;
				releasedMicros += entry.hold.reservedMicros;
			}
			return [
				new PendingReservationsExpired({
					nowMs: cmd.nowMs,
					expiredReservationIds: [
						first.reservationId,
						...rest.map((entry) => entry.reservationId),
					],
					freeHeadroomAfter: decodeNonNegativeUnits(
						state.freeHeadroom + restoredFree,
					),
					rateHeadroomAfter: decodeNonNegativeUnits(
						state.rateHeadroom + restoredRate,
					),
					concurrencyHeadroomAfter: decodeNonNegativeSlots(
						state.concurrencyHeadroom + restoredSlots,
					),
					heldMicrosAfter: decodeNonNegativeMicros(
						Math.max(0, state.heldMicros - releasedMicros),
					),
				}),
			];
		},
	},
	evolve: {
		DispatchAccountConfigured: (state, event) => ({
			_tag: "Configured" as const,
			listUnitMicros: event.listUnitMicros,
			freeHeadroom: event.freeHeadroom,
			rateHeadroom: event.rateHeadroom,
			concurrencyHeadroom: event.concurrencyHeadroom,
			budgetCapMicros: event.budgetCapMicros,
			spentMicros:
				state._tag === "Configured" ? state.spentMicros : ZERO_MICROS,
			heldMicros: state._tag === "Configured" ? state.heldMicros : ZERO_MICROS,
			overrunSeen: state._tag === "Configured" ? state.overrunSeen : false,
			reservations: state._tag === "Configured" ? state.reservations : [],
		}),
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
				reservations: [
					...state.reservations,
					{
						_tag: "Pending" as const,
						reservationId: event.reservationId,
						hold: event.hold,
						expiresAtMs: event.expiresAtMs,
					},
				],
			};
		},
		DispatchReservationStarted: (state, event) => {
			if (state._tag !== "Configured") {
				return state;
			}
			return {
				...state,
				reservations: state.reservations.map((entry) =>
					entry.reservationId === event.reservationId &&
					entry._tag === "Pending"
						? {
								_tag: "Running" as const,
								reservationId: entry.reservationId,
								hold: entry.hold,
							}
						: entry,
				),
			};
		},
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
				reservations: state.reservations.map((entry) =>
					entry.reservationId === event.reservationId
						? {
								_tag: "Released" as const,
								reservationId: entry.reservationId,
								reason: event.reason,
							}
						: entry,
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
				overrunSeen: state.overrunSeen || event.overrun,
				reservations: state.reservations.map((entry) =>
					entry.reservationId === event.reservationId
						? {
								_tag: "Confirmed" as const,
								reservationId: entry.reservationId,
								settledMicros: event.settledMicros,
								overrun: event.overrun,
								usageEvidenceRef: event.usageEvidenceRef,
							}
						: entry,
				),
			};
		},
		PendingReservationsExpired: (state, event) => {
			if (state._tag !== "Configured") {
				return state;
			}
			const expired = new Set<ReservationId>(event.expiredReservationIds);
			return {
				...state,
				freeHeadroom: event.freeHeadroomAfter,
				rateHeadroom: event.rateHeadroomAfter,
				concurrencyHeadroom: event.concurrencyHeadroomAfter,
				heldMicros: event.heldMicrosAfter,
				reservations: state.reservations.map((entry) =>
					expired.has(entry.reservationId)
						? {
								_tag: "Expired" as const,
								reservationId: entry.reservationId,
								expiredAtMs: event.nowMs,
							}
						: entry,
				),
			};
		},
	},
}) {}

function decodePositiveUnitsOne(): PositiveUnits {
	return Schema.decodeSync(PositiveUnits)(ONE_UNIT);
}
