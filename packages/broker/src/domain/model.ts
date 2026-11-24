import * as Domain from "@alchemy.run/domain";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { BudgetAccount } from "./BudgetAccount.aggregate.js";
import { ConnectionLifecycleState } from "./ids.js";
import { ProviderConnection } from "./ProviderConnection.aggregate.js";

const BudgetExposureState = Schema.Struct({
	ceilingMicros: Schema.NullOr(Schema.Int),
	settledMicros: Schema.Int,
	heldMicros: Schema.Int,
	uncertainHoldCount: Schema.Int,
	alertActive: Schema.Boolean,
});

export class BudgetExposureView extends Domain.View("BudgetExposureView", {
	from: [BudgetAccount],
	key: BudgetAccount,
	state: BudgetExposureState,
	initial: {
		ceilingMicros: null,
		settledMicros: 0,
		heldMicros: 0,
		uncertainHoldCount: 0,
		alertActive: false,
	},
	evolve: {
		BudgetCeilingConfigured: (state, event) => ({
			...state,
			ceilingMicros: event.ceilingMicros,
		}),
		BudgetHoldReserved: (state, event) => ({
			...state,
			heldMicros: state.heldMicros + event.amountMicros,
		}),
		BudgetHoldSettled: (state, event) => ({
			...state,
			settledMicros: state.settledMicros + event.settledMicros,
			heldMicros: Math.max(0, state.heldMicros - event.reservedMicros),
		}),
		BudgetHoldMarkedUncertain: (state) => ({
			...state,
			uncertainHoldCount: state.uncertainHoldCount + 1,
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

const ConnectionStatusState = Schema.Struct({
	status: ConnectionLifecycleState,
	providerId: Schema.NullOr(Schema.String),
	stationId: Schema.NullOr(Schema.String),
	revocationReason: Schema.NullOr(Schema.String),
});

export class ConnectionStatusView extends Domain.View("ConnectionStatusView", {
	from: [ProviderConnection],
	key: ProviderConnection,
	state: ConnectionStatusState,
	initial: {
		status: "uninitialized" as const,
		providerId: null,
		stationId: null,
		revocationReason: null,
	},
	evolve: {
		ProviderConnectionAuthorized: (state, event) => ({
			...state,
			status: "authorized" as const,
			providerId: event.providerId,
			stationId: event.stationId,
		}),
		ProviderConnectionRevoked: (state, event) => ({
			...state,
			status: "revoked" as const,
			revocationReason: event.reason,
		}),
	},
}) {}

export class BrokerControl extends Domain.Model(
	"BrokerControl",
	{
		aggregates: [BudgetAccount, ProviderConnection],
		views: [BudgetExposureView, ConnectionStatusView],
	},
	{
		description:
			"Broker budget authority holds, threshold alerts, and provider connection lifecycle.",
	},
) {}

export class BrokerControlApi extends Domain.Api(
	"BrokerControlApi",
	{
		model: BrokerControl,
		commands: [
			"ConfigureBudgetAccount",
			"ReserveBudgetHold",
			"SettleBudgetHold",
			"MarkBudgetHoldUncertain",
			"AuthorizeProviderConnection",
			"RevokeProviderConnection",
		],
		views: ["BudgetExposureView", "ConnectionStatusView"],
	},
	{
		description:
			"Control API for broker budget reservations and provider connection authorization.",
	},
) {}

export const BrokerControlHandlers = Layer.empty;
