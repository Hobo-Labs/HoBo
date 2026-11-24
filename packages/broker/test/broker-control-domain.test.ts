import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
	AuthorizeProviderConnection,
	BrokerControl,
	BrokerControlHandlers,
	BudgetAccount,
	BudgetAccountId,
	BudgetAlertThresholdCrossed,
	BudgetAlertThresholdRecovered,
	BudgetCeilingConfigured,
	BudgetExposureView,
	BudgetHoldId,
	BudgetHoldMarkedUncertain,
	BudgetHoldReserved,
	BudgetHoldSettled,
	BudgetLimitExceeded,
	ConfigureBudgetAccount,
	ConnectionAlreadyRevoked,
	ConnectionStatusView,
	MarkBudgetHoldUncertain,
	ProviderConnection,
	ProviderConnectionAuthorized,
	ProviderConnectionId,
	ProviderConnectionRevoked,
	ReserveBudgetHold,
	RevokeProviderConnection,
	SettleBudgetHold,
} from "../src/domain/index.js";

const story = Story.make(BrokerControl, {
	layer: BrokerControlHandlers,
});

describe("@hobo/broker/domain BrokerControl Alchemy Domain model", () => {
	it("passes Domain.verify static verification", () => {
		expect(Domain.verify(BrokerControl)).toEqual([]);
	});

	it("enforces hard budget ceilings, uncertain hold retention, and threshold crossing/recovery alerts", async () => {
		const acct = BudgetAccount.ref(BudgetAccountId.make("acct-prod-1"));
		const hold1 = BudgetHoldId.make("hold-vercel-1");
		const hold2 = BudgetHoldId.make("hold-cf-2");

		await Effect.runPromise(
			story(
				Story.when(
					acct,
					new ConfigureBudgetAccount({
						ceilingMicros: 100_000,
						alertThresholdMicros: 80_000,
					}),
				),
				Story.then(
					acct,
					new BudgetCeilingConfigured({
						ceilingMicros: 100_000,
						alertThresholdMicros: 80_000,
					}),
				),
				Story.when(
					acct,
					new ReserveBudgetHold({
						holdId: hold1,
						providerId: "vercel",
						amountMicros: 85_000,
					}),
				),
				Story.then(
					acct,
					new BudgetHoldReserved({
						holdId: hold1,
						providerId: "vercel",
						amountMicros: 85_000,
					}),
					new BudgetAlertThresholdCrossed({
						exposureMicros: 85_000,
						thresholdMicros: 80_000,
					}),
				),
				Story.when(
					acct,
					new ReserveBudgetHold({
						holdId: hold2,
						providerId: "cloudflare",
						amountMicros: 20_000,
					}),
				),
				Story.rejected(
					new BudgetLimitExceeded({
						exposureMicros: 85_000,
						requestedMicros: 20_000,
						ceilingMicros: 100_000,
					}),
				),
				Story.when(
					acct,
					new MarkBudgetHoldUncertain({
						holdId: hold1,
						reason: "provider-ack-timeout",
					}),
				),
				Story.then(
					acct,
					new BudgetHoldMarkedUncertain({
						holdId: hold1,
						reason: "provider-ack-timeout",
					}),
				),
				Story.when(
					acct,
					new SettleBudgetHold({
						holdId: hold1,
						settledMicros: 40_000,
					}),
				),
				Story.then(
					acct,
					new BudgetHoldSettled({
						holdId: hold1,
						reservedMicros: 85_000,
						settledMicros: 40_000,
					}),
					new BudgetAlertThresholdRecovered({
						exposureMicros: 40_000,
						thresholdMicros: 80_000,
					}),
				),
				Story.view(BudgetExposureView, acct, {
					settledMicros: 40_000,
					heldMicros: 0,
					uncertainHoldCount: 1,
					alertActive: false,
				}),
			),
		);
	});

	it("enforces irreversible provider connection revocation", async () => {
		const conn = ProviderConnection.ref(
			ProviderConnectionId.make("conn-vercel-prod"),
		);

		await Effect.runPromise(
			story(
				Story.when(
					conn,
					new AuthorizeProviderConnection({
						providerId: "vercel",
						stationId: "station-main",
						scopeRef: "scope:deployments",
					}),
				),
				Story.then(
					conn,
					new ProviderConnectionAuthorized({
						providerId: "vercel",
						stationId: "station-main",
						scopeRef: "scope:deployments",
					}),
				),
				Story.when(
					conn,
					new RevokeProviderConnection({ reason: "rotated-owner-grant" }),
				),
				Story.then(
					conn,
					new ProviderConnectionRevoked({
						providerId: "vercel",
						reason: "rotated-owner-grant",
					}),
				),
				Story.when(
					conn,
					new AuthorizeProviderConnection({
						providerId: "vercel",
						stationId: "station-main",
						scopeRef: "scope:deployments",
					}),
				),
				Story.rejected(new ConnectionAlreadyRevoked({ providerId: "vercel" })),
				Story.view(ConnectionStatusView, conn, {
					status: "revoked",
					revocationReason: "rotated-owner-grant",
				}),
			),
		);
	});
});
