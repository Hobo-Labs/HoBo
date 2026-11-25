import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
	BudgetAccountId,
	BudgetEpochMs,
	BudgetHoldId,
} from "./ids.js";

export class BudgetLimitExceeded extends Domain.Rejection(
	"BudgetLimitExceeded",
	{
		exposureMicros: Schema.Int,
		requestedMicros: Schema.Int,
		ceilingMicros: Schema.Int,
	},
) {}

export class DuplicateBudgetHold extends Domain.Rejection(
	"DuplicateBudgetHold",
	{
		holdId: BudgetHoldId,
	},
) {}

export class UnknownBudgetHold extends Domain.Rejection("UnknownBudgetHold", {
	holdId: BudgetHoldId,
}) {}

export class BudgetAccountNotConfigured extends Domain.Rejection(
	"BudgetAccountNotConfigured",
	{
		accountId: BudgetAccountId,
	},
) {}

export class BudgetCeilingBelowLiabilities extends Domain.Rejection(
	"BudgetCeilingBelowLiabilities",
	{
		liabilitiesMicros: Schema.Int,
		requestedCeilingMicros: Schema.Int,
	},
) {}

export class BudgetNegativeAmountRejected extends Domain.Rejection(
	"BudgetNegativeAmountRejected",
	{
		field: Schema.String,
		amountMicros: Schema.Int,
	},
) {}

export class UncertainBudgetHoldNotSettleable extends Domain.Rejection(
	"UncertainBudgetHoldNotSettleable",
	{
		holdId: BudgetHoldId,
	},
) {}

export class SettlementExceedsHold extends Domain.Rejection(
	"SettlementExceedsHold",
	{
		holdId: BudgetHoldId,
		reservedMicros: Schema.Int,
		settledMicros: Schema.Int,
	},
) {}

export class BudgetHoldNotReleasable extends Domain.Rejection(
	"BudgetHoldNotReleasable",
	{
		holdId: BudgetHoldId,
	},
) {}

export class BudgetHoldNotResolvable extends Domain.Rejection(
	"BudgetHoldNotResolvable",
	{
		holdId: BudgetHoldId,
	},
) {}

export class BudgetCeilingConfigured extends Domain.Event(
	"BudgetCeilingConfigured",
	{
		ceilingMicros: Schema.Int,
		alertThresholdMicros: Schema.Int,
	},
) {}

export class BudgetHoldReserved extends Domain.Event("BudgetHoldReserved", {
	holdId: BudgetHoldId,
	providerId: Schema.String,
	amountMicros: Schema.Int,
	expiresAtMs: Schema.NullOr(BudgetEpochMs),
}) {}

export class BudgetHoldReleased extends Domain.Event("BudgetHoldReleased", {
	holdId: BudgetHoldId,
	reason: Schema.String,
	releasedMicros: Schema.Int,
}) {}

export class BudgetHoldResolved extends Domain.Event("BudgetHoldResolved", {
	holdId: BudgetHoldId,
	evidenceRef: Schema.String,
}) {}

export class BudgetHoldsExpired extends Domain.Event("BudgetHoldsExpired", {
	nowMs: BudgetEpochMs,
	expiredHoldIds: Schema.NonEmptyArray(BudgetHoldId),
	releasedMicros: Schema.Int,
}) {}

export class BudgetHoldSettled extends Domain.Event("BudgetHoldSettled", {
	holdId: BudgetHoldId,
	reservedMicros: Schema.Int,
	settledMicros: Schema.Int,
}) {}

export class BudgetHoldMarkedUncertain extends Domain.Event(
	"BudgetHoldMarkedUncertain",
	{
		holdId: BudgetHoldId,
		reason: Schema.String,
	},
) {}

export class BudgetAlertThresholdCrossed extends Domain.Event(
	"BudgetAlertThresholdCrossed",
	{
		exposureMicros: Schema.Int,
		thresholdMicros: Schema.Int,
	},
) {}

export class BudgetAlertThresholdRecovered extends Domain.Event(
	"BudgetAlertThresholdRecovered",
	{
		exposureMicros: Schema.Int,
		thresholdMicros: Schema.Int,
	},
) {}

export class ConfigureBudgetAccount extends Domain.Command(
	"ConfigureBudgetAccount",
	{
		target: BudgetAccountId,
		input: {
			ceilingMicros: Schema.Int,
			alertThresholdMicros: Schema.Int,
		},
		events: [BudgetCeilingConfigured],
		rejects: [BudgetCeilingBelowLiabilities, BudgetNegativeAmountRejected],
	},
	{
		description:
			"Configure spend ceiling and alert threshold for a broker budget account.",
	},
) {}

export class ReserveBudgetHold extends Domain.Command(
	"ReserveBudgetHold",
	{
		target: BudgetAccountId,
		input: {
			holdId: BudgetHoldId,
			providerId: Schema.String,
			amountMicros: Schema.Int,
			expiresAtMs: Schema.NullOr(BudgetEpochMs),
		},
		events: [BudgetHoldReserved, BudgetAlertThresholdCrossed],
		rejects: [
			BudgetAccountNotConfigured,
			BudgetLimitExceeded,
			DuplicateBudgetHold,
			BudgetNegativeAmountRejected,
		],
	},
	{
		description:
			"Atomically reserve a budget hold within ceiling and emit threshold crossing when applicable.",
	},
) {}

export class SettleBudgetHold extends Domain.Command(
	"SettleBudgetHold",
	{
		target: BudgetAccountId,
		input: {
			holdId: BudgetHoldId,
			settledMicros: Schema.Int,
		},
		events: [BudgetHoldSettled, BudgetAlertThresholdRecovered],
		rejects: [
			UnknownBudgetHold,
			UncertainBudgetHoldNotSettleable,
			BudgetNegativeAmountRejected,
			SettlementExceedsHold,
		],
	},
	{
		description:
			"Settle a budget hold against observed spend and emit threshold recovery if exposure drops.",
	},
) {}

export class ReleaseBudgetHold extends Domain.Command(
	"ReleaseBudgetHold",
	{
		target: BudgetAccountId,
		input: {
			holdId: BudgetHoldId,
			reason: Schema.String,
		},
		events: [BudgetHoldReleased, BudgetAlertThresholdRecovered],
		rejects: [UnknownBudgetHold, BudgetHoldNotReleasable],
	},
	{
		description:
			"Release an unused, reconciled hold and restore headroom without realizing spend.",
	},
) {}

export class ResolveBudgetHold extends Domain.Command(
	"ResolveBudgetHold",
	{
		target: BudgetAccountId,
		input: {
			holdId: BudgetHoldId,
			evidenceRef: Schema.String,
		},
		events: [BudgetHoldResolved],
		rejects: [UnknownBudgetHold, BudgetHoldNotResolvable],
	},
	{
		description:
			"Clear uncertainty on a hold after external reconciliation so it can settle or release.",
	},
) {}

export class ExpireBudgetHolds extends Domain.Command(
	"ExpireBudgetHolds",
	{
		target: BudgetAccountId,
		input: {
			nowMs: BudgetEpochMs,
		},
		events: [BudgetHoldsExpired, BudgetAlertThresholdRecovered],
		rejects: [BudgetAccountNotConfigured],
	},
	{
		description:
			"Atomically expire active holds whose deadline has passed at or before nowMs.",
	},
) {}

export class MarkBudgetHoldUncertain extends Domain.Command(
	"MarkBudgetHoldUncertain",
	{
		target: BudgetAccountId,
		input: {
			holdId: BudgetHoldId,
			reason: Schema.String,
		},
		events: [BudgetHoldMarkedUncertain],
		rejects: [UnknownBudgetHold],
	},
	{
		description:
			"Retain exposure on an uncertain hold pending external reconciliation.",
	},
) {}

const ActiveHoldEntry = Schema.Struct({
	holdId: BudgetHoldId,
	providerId: Schema.String,
	amountMicros: Schema.Int,
	uncertain: Schema.Boolean,
	expiresAtMs: Schema.NullOr(BudgetEpochMs),
});

const BudgetAccountState = Schema.Struct({
	ceilingMicros: Schema.NullOr(Schema.Int),
	alertThresholdMicros: Schema.NullOr(Schema.Int),
	alertActive: Schema.Boolean,
	settledMicros: Schema.Int,
	heldMicros: Schema.Int,
	holds: Schema.Array(ActiveHoldEntry),
});

export class BudgetAccount extends Domain.Aggregate("BudgetAccount", {
	id: BudgetAccountId,
	state: BudgetAccountState,
	initial: {
		ceilingMicros: null,
		alertThresholdMicros: null,
		alertActive: false,
		settledMicros: 0,
		heldMicros: 0,
		holds: [],
	},
	commands: [
		ConfigureBudgetAccount,
		ReserveBudgetHold,
		SettleBudgetHold,
		ReleaseBudgetHold,
		ResolveBudgetHold,
		ExpireBudgetHolds,
		MarkBudgetHoldUncertain,
	],
	decide: {
		ConfigureBudgetAccount: (state, cmd) => {
			if (cmd.ceilingMicros < 0) {
				return new BudgetNegativeAmountRejected({
					field: "ceilingMicros",
					amountMicros: cmd.ceilingMicros,
				});
			}
			if (cmd.alertThresholdMicros < 0) {
				return new BudgetNegativeAmountRejected({
					field: "alertThresholdMicros",
					amountMicros: cmd.alertThresholdMicros,
				});
			}
			const liabilities = state.settledMicros + state.heldMicros;
			if (cmd.ceilingMicros < liabilities) {
				return new BudgetCeilingBelowLiabilities({
					liabilitiesMicros: liabilities,
					requestedCeilingMicros: cmd.ceilingMicros,
				});
			}
			return [
				new BudgetCeilingConfigured({
					ceilingMicros: cmd.ceilingMicros,
					alertThresholdMicros: cmd.alertThresholdMicros,
				}),
			];
		},
		ReserveBudgetHold: (state, cmd, { id }) => {
			if (state.ceilingMicros === null) {
				return new BudgetAccountNotConfigured({ accountId: id });
			}
			if (state.holds.some((item) => item.holdId === cmd.holdId)) {
				return new DuplicateBudgetHold({ holdId: cmd.holdId });
			}
			if (cmd.amountMicros < 0) {
				return new BudgetNegativeAmountRejected({
					field: "amountMicros",
					amountMicros: cmd.amountMicros,
				});
			}
			const amount = cmd.amountMicros;
			const currentExposure = state.settledMicros + state.heldMicros;
			if (
				state.ceilingMicros !== null &&
				currentExposure + amount > state.ceilingMicros
			) {
				return new BudgetLimitExceeded({
					exposureMicros: currentExposure,
					requestedMicros: amount,
					ceilingMicros: state.ceilingMicros,
				});
			}
			const nextExposure = currentExposure + amount;
			const reserved = new BudgetHoldReserved({
				holdId: cmd.holdId,
				providerId: cmd.providerId,
				amountMicros: amount,
				expiresAtMs: cmd.expiresAtMs,
			});
			if (
				!state.alertActive &&
				state.alertThresholdMicros !== null &&
				nextExposure >= state.alertThresholdMicros
			) {
				return [
					reserved,
					new BudgetAlertThresholdCrossed({
						exposureMicros: nextExposure,
						thresholdMicros: state.alertThresholdMicros,
					}),
				];
			}
			return [reserved];
		},
		SettleBudgetHold: (state, cmd) => {
			const hold = state.holds.find((item) => item.holdId === cmd.holdId);
			if (hold === undefined) {
				return new UnknownBudgetHold({ holdId: cmd.holdId });
			}
			if (hold.uncertain) {
				return new UncertainBudgetHoldNotSettleable({ holdId: cmd.holdId });
			}
			if (cmd.settledMicros < 0) {
				return new BudgetNegativeAmountRejected({
					field: "settledMicros",
					amountMicros: cmd.settledMicros,
				});
			}
			if (cmd.settledMicros > hold.amountMicros) {
				return new SettlementExceedsHold({
					holdId: hold.holdId,
					reservedMicros: hold.amountMicros,
					settledMicros: cmd.settledMicros,
				});
			}
			const settledAmount = cmd.settledMicros;
			const nextExposure =
				state.settledMicros +
				settledAmount +
				Math.max(0, state.heldMicros - hold.amountMicros);
			const settledEvent = new BudgetHoldSettled({
				holdId: hold.holdId,
				reservedMicros: hold.amountMicros,
				settledMicros: settledAmount,
			});
			if (
				state.alertActive &&
				state.alertThresholdMicros !== null &&
				nextExposure < state.alertThresholdMicros
			) {
				return [
					settledEvent,
					new BudgetAlertThresholdRecovered({
						exposureMicros: nextExposure,
						thresholdMicros: state.alertThresholdMicros,
					}),
				];
			}
			return [settledEvent];
		},
		ReleaseBudgetHold: (state, cmd) => {
			const hold = state.holds.find((item) => item.holdId === cmd.holdId);
			if (hold === undefined) {
				return new UnknownBudgetHold({ holdId: cmd.holdId });
			}
			if (hold.uncertain) {
				return new BudgetHoldNotReleasable({ holdId: cmd.holdId });
			}
			const nextHeldMicros = Math.max(0, state.heldMicros - hold.amountMicros);
			const nextExposure = state.settledMicros + nextHeldMicros;
			const released = new BudgetHoldReleased({
				holdId: hold.holdId,
				reason: cmd.reason,
				releasedMicros: hold.amountMicros,
			});
			if (
				state.alertActive &&
				state.alertThresholdMicros !== null &&
				nextExposure < state.alertThresholdMicros
			) {
				return [
					released,
					new BudgetAlertThresholdRecovered({
						exposureMicros: nextExposure,
						thresholdMicros: state.alertThresholdMicros,
					}),
				];
			}
			return [released];
		},
		ResolveBudgetHold: (state, cmd) => {
			const hold = state.holds.find((item) => item.holdId === cmd.holdId);
			if (hold === undefined) {
				return new UnknownBudgetHold({ holdId: cmd.holdId });
			}
			if (!hold.uncertain) {
				return new BudgetHoldNotResolvable({ holdId: cmd.holdId });
			}
			return [
				new BudgetHoldResolved({
					holdId: cmd.holdId,
					evidenceRef: cmd.evidenceRef,
				}),
			];
		},
		ExpireBudgetHolds: (state, cmd, { id }) => {
			if (state.ceilingMicros === null) {
				return new BudgetAccountNotConfigured({ accountId: id });
			}
			const due = state.holds.filter(
				(item) =>
					item.expiresAtMs !== null && item.expiresAtMs <= cmd.nowMs,
			);
			const [first, ...rest] = due;
			if (first === undefined) {
				return [];
			}
			let releasedMicros = 0;
			for (const entry of due) {
				releasedMicros += entry.amountMicros;
			}
			const nextHeldMicros = Math.max(0, state.heldMicros - releasedMicros);
			const nextExposure = state.settledMicros + nextHeldMicros;
			const expired = new BudgetHoldsExpired({
				nowMs: cmd.nowMs,
				expiredHoldIds: [first.holdId, ...rest.map((entry) => entry.holdId)],
				releasedMicros,
			});
			if (
				state.alertActive &&
				state.alertThresholdMicros !== null &&
				nextExposure < state.alertThresholdMicros
			) {
				return [
					expired,
					new BudgetAlertThresholdRecovered({
						exposureMicros: nextExposure,
						thresholdMicros: state.alertThresholdMicros,
					}),
				];
			}
			return [expired];
		},
		MarkBudgetHoldUncertain: (state, cmd) => {
			const hold = state.holds.find((item) => item.holdId === cmd.holdId);
			if (hold === undefined) {
				return new UnknownBudgetHold({ holdId: cmd.holdId });
			}
			if (hold.uncertain) {
				return [];
			}
			return [
				new BudgetHoldMarkedUncertain({
					holdId: cmd.holdId,
					reason: cmd.reason,
				}),
			];
		},
	},
	evolve: {
		BudgetCeilingConfigured: (state, event) => ({
			...state,
			ceilingMicros: event.ceilingMicros,
			alertThresholdMicros: event.alertThresholdMicros,
		}),
		BudgetHoldReserved: (state, event) => ({
			...state,
			heldMicros: state.heldMicros + event.amountMicros,
			holds: [
				...state.holds,
				{
					holdId: event.holdId,
					providerId: event.providerId,
					amountMicros: event.amountMicros,
					uncertain: false,
					expiresAtMs: event.expiresAtMs,
				},
			],
		}),
		BudgetHoldReleased: (state, event) => ({
			...state,
			heldMicros: Math.max(0, state.heldMicros - event.releasedMicros),
			holds: state.holds.filter((item) => item.holdId !== event.holdId),
		}),
		BudgetHoldResolved: (state, event) => ({
			...state,
			holds: state.holds.map((item) =>
				item.holdId === event.holdId ? { ...item, uncertain: false } : item,
			),
		}),
		BudgetHoldsExpired: (state, event) => {
			const expired = new Set(event.expiredHoldIds);
			let releasedMicros = 0;
			for (const entry of state.holds) {
				if (expired.has(entry.holdId)) {
					releasedMicros += entry.amountMicros;
				}
			}
			return {
				...state,
				heldMicros: Math.max(0, state.heldMicros - releasedMicros),
				holds: state.holds.filter((item) => !expired.has(item.holdId)),
			};
		},
		BudgetHoldSettled: (state, event) => ({
			...state,
			settledMicros: state.settledMicros + event.settledMicros,
			heldMicros: Math.max(0, state.heldMicros - event.reservedMicros),
			holds: state.holds.filter((item) => item.holdId !== event.holdId),
		}),
		BudgetHoldMarkedUncertain: (state, event) => ({
			...state,
			holds: state.holds.map((item) =>
				item.holdId === event.holdId ? { ...item, uncertain: true } : item,
			),
		}),
		BudgetAlertThresholdCrossed: (state) => ({
			...state,
			alertActive: true,
		}),
		BudgetAlertThresholdRecovered: (state) => ({
			...state,
			alertActive: false,
		}),
	},
}) {}