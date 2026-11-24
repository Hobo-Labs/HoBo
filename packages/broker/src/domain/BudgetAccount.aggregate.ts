import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { BudgetAccountId, BudgetHoldId } from "./ids.js";

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
		rejects: [],
	},
	{ description: "Configure spend ceiling and alert threshold for a broker budget account." },
) {}

export class ReserveBudgetHold extends Domain.Command(
	"ReserveBudgetHold",
	{
		target: BudgetAccountId,
		input: {
			holdId: BudgetHoldId,
			providerId: Schema.String,
			amountMicros: Schema.Int,
		},
		events: [BudgetHoldReserved, BudgetAlertThresholdCrossed],
		rejects: [BudgetLimitExceeded, DuplicateBudgetHold],
	},
	{ description: "Atomically reserve a budget hold within ceiling and emit threshold crossing when applicable." },
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
		rejects: [UnknownBudgetHold],
	},
	{ description: "Settle a budget hold against observed spend and emit threshold recovery if exposure drops." },
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
	{ description: "Retain exposure on an uncertain hold pending external reconciliation." },
) {}

const ActiveHoldEntry = Schema.Struct({
	holdId: BudgetHoldId,
	providerId: Schema.String,
	amountMicros: Schema.Int,
	uncertain: Schema.Boolean,
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
		MarkBudgetHoldUncertain,
	],
	decide: {
		ConfigureBudgetAccount: (_state, cmd) => [
			new BudgetCeilingConfigured({
				ceilingMicros: Math.max(0, cmd.ceilingMicros),
				alertThresholdMicros: Math.max(0, cmd.alertThresholdMicros),
			}),
		],
		ReserveBudgetHold: (state, cmd) => {
			if (state.holds.some((item) => item.holdId === cmd.holdId)) {
				return new DuplicateBudgetHold({ holdId: cmd.holdId });
			}
			const amount = Math.max(0, cmd.amountMicros);
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
			const settledAmount = Math.max(0, cmd.settledMicros);
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
		MarkBudgetHoldUncertain: (state, cmd) => {
			const hold = state.holds.find((item) => item.holdId === cmd.holdId);
			if (hold === undefined) {
				return new UnknownBudgetHold({ holdId: cmd.holdId });
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
				},
			],
		}),
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
