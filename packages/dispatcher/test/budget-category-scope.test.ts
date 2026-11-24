import fc from "fast-check";
import { expect, it } from "vitest";
import {
	createDispatcherRegistry,
	createReservationLedger,
	decideAndReserveDispatch,
} from "../src/dispatcher.js";

const categories = [
	{ category: "runner", dimension: "runner.minutes" },
	{ category: "build-machine", dimension: "build.minutes" },
	{ category: "traffic-backend", dimension: "traffic.requests" },
] as const;

it("holds the selected runner budget when the same provider has a build registration first", () => {
	const registry = createDispatcherRegistry([
		{ providerId: "p", category: "build-machine", listUnitCost: 0 },
		{ providerId: "p", category: "runner", listUnitCost: 1 },
	]);
	const ledger = createReservationLedger({
		view: "CreditLedgerView",
		seq: 0,
		accounts: [
			{
				providerId: "p",
				dimension: "runner.minutes",
				listUnitCost: 1,
				freeHeadroom: 0,
				budgetCap: 1,
				spendToDate: 0,
			},
		],
	});
	const dispatch = (dispatchId: string) =>
		decideAndReserveDispatch({
			registry,
			reservationLedger: ledger,
			category: "runner",
			dispatchId,
			units: 1,
		});
	const first = dispatch("one");
	expect(first.ok).toBe(true);
	expect(first.reservation?.reservation).toMatchObject({
		dimension: "runner.minutes",
		reservedCost: 1,
	});
	expect(ledger.snapshot().accounts[0].reservedCost).toBe(1);
	expect(dispatch("two").ok).toBe(false);
});

it.each([
	["wrong-dimension", "pending"],
	["wrong-dimension", "running"],
	["wrong-dimension", "confirmed"],
	["underpriced", "pending"],
	["underpriced", "confirmed"],
] as const)("quarantines an earlier %s reservation in %s state", (problem, status) => {
	const registry = createDispatcherRegistry([
		{
			providerId: "p",
			category: "build-machine",
			dimension: problem === "underpriced" ? "runner.minutes" : "build.minutes",
			listUnitCost: 0,
		},
		{ providerId: "p", category: "runner", listUnitCost: 1 },
	]);
	const ledger = createReservationLedger({
		view: "CreditLedgerView",
		seq: 0,
		accounts: [
			{
				providerId: "p",
				dimension: "runner.minutes",
				freeHeadroom: 0,
				budgetCap: 1,
				spendToDate: 0,
			},
		],
	});
	const request = {
		registry,
		reservationLedger: ledger,
		category: "runner",
		dispatchId: "old",
		units: 1,
	};
	expect(decideAndReserveDispatch(request).ok).toBe(true);
	const snapshot = ledger.snapshot();
	const reservation = snapshot.reservations?.[0];
	if (!reservation) throw new Error("missing reservation");
	reservation.status = status;
	reservation.dimension =
		problem === "underpriced" ? "runner.minutes" : "build.minutes";
	reservation.reservedCost = problem === "wrong-dimension" ? 1 : 0;
	reservation.unitCost = 0;
	snapshot.accounts[0].reservedCost = 0;
	snapshot.accounts[0].reservedUnits = 0;
	const imported = createReservationLedger(snapshot);
	const before = imported.snapshot();
	const retry = decideAndReserveDispatch({
		...request,
		reservationLedger: imported,
	});
	expect(retry.ok).toBe(false);
	expect(retry.reason).toBe("ledger-reconciliation-required");
	const next = decideAndReserveDispatch({
		...request,
		reservationLedger: imported,
		dispatchId: "new",
	});
	expect(next.ok).toBe(false);
	expect(next.reason).toBe("ledger-reconciliation-required");
	expect(imported.snapshot()).toEqual(before);
});

it("rejects a retry when its recorded quote no longer covers the request estimate", () => {
	const registry = createDispatcherRegistry([
		{ providerId: "p", category: "runner", listUnitCost: 0 },
	]);
	const ledger = createReservationLedger({
		view: "CreditLedgerView",
		seq: 0,
		accounts: [
			{
				providerId: "p",
				dimension: "runner.minutes",
				freeHeadroom: 0,
				budgetCap: 1,
				spendToDate: 0,
			},
		],
	});
	const request = {
		registry,
		reservationLedger: ledger,
		category: "runner",
		dispatchId: "estimated",
		units: 1,
		estimatedCost: 1,
	};
	expect(decideAndReserveDispatch(request).ok).toBe(true);
	const snapshot = ledger.snapshot();
	const reservation = snapshot.reservations?.[0];
	if (!reservation) throw new Error("missing reservation");
	reservation.reservedCost = 0;
	reservation.estimatedCost = 0;
	snapshot.accounts[0].reservedCost = 0;
	const imported = createReservationLedger(snapshot);
	const result = decideAndReserveDispatch({
		...request,
		reservationLedger: imported,
	});
	expect(result.ok).toBe(false);
	expect(result.reason).toBe("reservation-replay-scope-or-cost-conflict");
});

it("binds the hold to the selected category for every category pair and registry order", () => {
	fc.assert(
		fc.property(
			fc.integer({ min: 0, max: 2 }),
			fc.integer({ min: 1, max: 2 }),
			fc.integer({ min: 1, max: 100 }),
			fc.boolean(),
			fc.boolean(),
			(targetIndex, offset, price, reverse, includeOtherAccount) => {
				const target = categories[targetIndex];
				const other = categories[(targetIndex + offset) % categories.length];
				if (!target || !other) throw new Error("missing category fixture");
				const providers = [
					{ providerId: "p", category: other.category, listUnitCost: 0 },
					{ providerId: "p", category: target.category, listUnitCost: price },
				];
				const registry = createDispatcherRegistry(
					reverse ? providers.reverse() : providers,
				);
				const targetAccount = {
					providerId: "p",
					dimension: target.dimension,
					listUnitCost: price,
					freeHeadroom: 0,
					budgetCap: price,
					spendToDate: 0,
				};
				const otherAccount = {
					providerId: "p",
					dimension: other.dimension,
					listUnitCost: 0,
					freeHeadroom: 0,
					budgetCap: 1000,
					spendToDate: 0,
				};
				const ledger = createReservationLedger({
					view: "CreditLedgerView",
					seq: 0,
					accounts: includeOtherAccount
						? [targetAccount, otherAccount]
						: [targetAccount],
				});
				const dispatch = (dispatchId: string) =>
					decideAndReserveDispatch({
						registry,
						reservationLedger: ledger,
						category: target.category,
						dispatchId,
						units: 1,
					});
				const first = dispatch("one");
				expect(first.ok).toBe(true);
				expect(first.reservation?.reservation).toMatchObject({
					dimension: target.dimension,
					reservedCost: price,
				});
				expect(ledger.snapshot().accounts[0].reservedCost).toBe(price);
				if (includeOtherAccount)
					expect(ledger.snapshot().accounts[1].reservedCost ?? 0).toBe(0);
				const committed = ledger.snapshot();
				expect(dispatch("one").reservation?.replayed).toBe(true);
				expect(ledger.snapshot()).toEqual(committed);
				expect(dispatch("two").ok).toBe(false);
			},
		),
		{ seed: 614479, numRuns: 300 },
	);
});
