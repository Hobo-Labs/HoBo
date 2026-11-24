import fc from "fast-check";
import { expect, it } from "vitest";
import {
	createDispatcherRegistry,
	createReservationLedger,
	decideAndReserveDispatch,
	replayDispatchDecision,
} from "../src/dispatcher.js";

it("tries the affordable provider when the cheapest cannot cover the all-in estimate", () => {
	const registry = createDispatcherRegistry([
		{ providerId: "cheap", category: "runner", listUnitCost: 0 },
		{ providerId: "funded", category: "runner", listUnitCost: 1 },
	]);
	const ledger = createReservationLedger({
		view: "CreditLedgerView",
		seq: 0,
		accounts: [
			{
				providerId: "cheap",
				dimension: "runner.minutes",
				listUnitCost: 0,
				budgetCap: 1,
				spendToDate: 0,
				freeHeadroom: 0,
			},
			{
				providerId: "funded",
				dimension: "runner.minutes",
				listUnitCost: 1,
				budgetCap: 3,
				spendToDate: 0,
				freeHeadroom: 0,
			},
		],
	});
	const request = {
		registry,
		reservationLedger: ledger,
		category: "runner",
		dispatchId: "estimate",
		units: 1,
		estimatedCost: 2,
	};
	const first = decideAndReserveDispatch(request);
	expect(first.ok).toBe(true);
	expect(first.selectedProvider).toBe("funded");
	expect(first.reservation?.reservation).toMatchObject({
		providerId: "funded",
		reservedCost: 2,
	});
	expect(first.replayInput?.estimatedCost).toBe(2);
	const before = ledger.snapshot();
	const retry = decideAndReserveDispatch(request);
	expect(retry.reservation?.replayed).toBe(true);
	expect(retry.dispatchEvent).toEqual(first.dispatchEvent);
	expect(ledger.snapshot()).toEqual(before);
});

it("replays a valid older record that did not store its estimate in the decision input", () => {
	const registry = createDispatcherRegistry([
		{ providerId: "cheap", category: "runner", listUnitCost: 1 },
		{ providerId: "funded", category: "runner", listUnitCost: 1 },
	]);
	const ledger = createReservationLedger({
		view: "CreditLedgerView",
		seq: 0,
		accounts: [
			{
				providerId: "cheap",
				dimension: "runner.minutes",
				listUnitCost: 1,
				budgetCap: 0,
				spendToDate: 0,
				freeHeadroom: 0,
			},
			{
				providerId: "funded",
				dimension: "runner.minutes",
				listUnitCost: 1,
				budgetCap: 3,
				spendToDate: 0,
				freeHeadroom: 0,
			},
		],
	});
	const request = {
		registry,
		reservationLedger: ledger,
		category: "runner",
		dispatchId: "legacy",
		units: 1,
		estimatedCost: 2,
	};
	const first = decideAndReserveDispatch(request);
	expect(first.ok).toBe(true);
	const saved = ledger.snapshot();
	const reservation = saved.reservations?.[0];
	if (!reservation?.decisionInputJson) throw new Error("missing replay input");
	const replay = JSON.parse(reservation.decisionInputJson);
	delete replay.estimatedCost;
	reservation.decisionInputJson = JSON.stringify(replay);
	const restored = createReservationLedger(saved);
	const retry = decideAndReserveDispatch({
		...request,
		reservationLedger: restored,
	});
	expect(retry.ok).toBe(true);
	expect(retry.reservation?.replayed).toBe(true);
	expect(retry.dispatchEvent).toEqual(first.dispatchEvent);
});

it("ranks only providers whose budget covers both the price and estimate", () => {
	fc.assert(
		fc.property(
			fc.integer({ min: 0, max: 5 }),
			fc.integer({ min: 0, max: 5 }),
			fc.integer({ min: 0, max: 25 }),
			fc.integer({ min: 0, max: 25 }),
			fc.integer({ min: 0, max: 25 }),
			fc.integer({ min: 1, max: 4 }),
			(priceA, priceB, capA, capB, estimatedCost, units) => {
				const candidates = [
					{ providerId: "a", price: priceA, cap: capA },
					{ providerId: "b", price: priceB, cap: capB },
				];
				const registry = createDispatcherRegistry(
					candidates.map(({ providerId, price }) => ({
						providerId,
						category: "runner",
						listUnitCost: price,
					})),
				);
				const ledger = createReservationLedger({
					view: "CreditLedgerView",
					seq: 0,
					accounts: candidates.map(({ providerId, price, cap }) => ({
						providerId,
						dimension: "runner.minutes",
						listUnitCost: price,
						freeHeadroom: 0,
						budgetCap: cap,
						spendToDate: 0,
					})),
				});
				const expected = candidates
					.filter(
						({ price, cap }) => Math.max(price * units, estimatedCost) <= cap,
					)
					.sort(
						(a, b) =>
							a.price - b.price || a.providerId.localeCompare(b.providerId),
					)[0];
				const request = {
					registry,
					reservationLedger: ledger,
					category: "runner",
					dispatchId: "property",
					units,
					estimatedCost,
				};
				const result = decideAndReserveDispatch(request);
				if (!expected) {
					expect(result.ok).toBe(false);
					expect(ledger.snapshot().seq).toBe(0);
					return;
				}
				expect(result.ok).toBe(true);
				expect(result.selectedProvider).toBe(expected.providerId);
				expect(result.reservation?.reservation).toMatchObject({
					providerId: expected.providerId,
					reservedCost: Math.max(expected.price * units, estimatedCost),
				});
				expect(
					replayDispatchDecision(result.replayInput).dispatchEvent,
				).toEqual(result.dispatchEvent);
				const committed = ledger.snapshot();
				expect(decideAndReserveDispatch(request).reservation?.replayed).toBe(
					true,
				);
				expect(ledger.snapshot()).toEqual(committed);
			},
		),
		{ seed: 614480, numRuns: 300 },
	);
});
