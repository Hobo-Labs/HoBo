import { describe, expect, it } from "vitest";
import {
	createDispatcherRegistry,
	createReservationLedger,
	decideAndReserveDispatch,
	decideCreditDispatch,
	decidePlacement,
	replayDispatchDecision,
} from "../src/dispatcher.js";

const offers = [
	{ providerId: "paid", listUnitCost: 1, freeHeadroom: 0 },
	{ providerId: "credit", listUnitCost: 10, freeHeadroom: 1 },
	{ providerId: "more-credit", listUnitCost: 10, freeHeadroom: 2 },
];
const registry = createDispatcherRegistry(
	offers.map(({ providerId, listUnitCost }) => ({
		providerId,
		category: "runner",
		listUnitCost,
	})),
);
const ledgerView = {
	view: "CreditLedgerView",
	seq: 0,
	accounts: offers.map(({ providerId, listUnitCost, freeHeadroom }) => ({
		providerId,
		dimension: "runner.minutes",
		listUnitCost,
		freeHeadroom,
	})),
};
const request = {
	registry,
	category: "runner",
	dispatchId: "job",
	units: 10,
	ledgerView,
};

describe("dispatch objectives", () => {
	it("chooses the lowest cost or the most credited units as requested", () => {
		const cheapest = decideCreditDispatch({
			...request,
			objective: "min-cost",
		});
		const credits = decideCreditDispatch({
			...request,
			objective: "maximize-credits",
		});
		expect(cheapest.selectedProvider).toBe("paid");
		expect(credits.selectedProvider).toBe("more-credit");
		expect(credits.dispatchEvent.data.objective).toBe("maximize-credits");
		expect(replayDispatchDecision(credits.replayInput).dispatchEvent).toEqual(
			credits.dispatchEvent,
		);
	});

	it("excludes a credit-rich provider that exceeds its budget", () => {
		const cappedLedger = {
			...ledgerView,
			accounts: ledgerView.accounts.map((account) =>
				account.providerId === "more-credit"
					? { ...account, budgetCap: 50 }
					: account,
			),
		};
		const decision = decideCreditDispatch({
			...request,
			objective: "maximize-credits",
			ledgerView: cappedLedger,
		});
		expect(decision.selectedProvider).toBe("credit");
		expect(
			decision.ranking.find((entry) => entry.providerId === "more-credit")
				?.budgetExceeded,
		).toBe(true);
	});

	it("applies the requested objective when choosing a placement", () => {
		const candidates = offers.map(({ providerId, listUnitCost }) => ({
			definitionId: providerId,
			providerId,
			registered: true,
			resourceType: "worker",
			dimension: "runner.minutes",
			listUnitCost,
		}));
		const placement = {
			resourceId: "worker",
			resourceType: "worker",
			units: 10,
			candidates,
			ledgerView,
		};
		expect(
			decidePlacement({ ...placement, objective: "min-cost" }).winner,
		).toBe("paid");
		expect(
			decidePlacement({ ...placement, objective: "maximize-credits" }).winner,
		).toBe("more-credit");
	});

	it("retains the requested objective when reserving and retrying", () => {
		const reservationLedger = createReservationLedger(ledgerView);
		const { ledgerView: _view, ...input } = request;
		const first = decideAndReserveDispatch({
			...input,
			objective: "maximize-credits",
			reservationLedger,
		});
		const retry = decideAndReserveDispatch({
			...input,
			objective: "maximize-credits",
			reservationLedger,
		});
		expect(first.selectedProvider).toBe("more-credit");
		expect(retry.dispatchEvent).toEqual(first.dispatchEvent);
		expect(retry.reservation.replayed).toBe(true);
	});
});
