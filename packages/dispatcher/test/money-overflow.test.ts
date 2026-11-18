import { expect, it } from "vitest";
import { createReservationLedger } from "../src/dispatcher.js";
import {
	addAvailable,
	addUpper,
	availableCredits,
	exposureWithinBudget,
} from "../src/money.js";

it("rejects non-finite estimated exposure during budget admission", () => {
	expect(exposureWithinBudget(1, 0, 1, 0, Number.NaN, 10, 0, 0)).toBe(false);
	expect(
		exposureWithinBudget(1, 0, 1, 0, Number.POSITIVE_INFINITY, 10, 0, 0),
	).toBe(false);
	expect(exposureWithinBudget(1, 0, 1, 0, -1, 10, 0, 0)).toBe(false);
});

it("keeps overflowing available amounts finite without understating liabilities", () => {
	const largest = Number.MAX_VALUE;
	expect(addAvailable(largest, largest)).toBe(largest);
	expect(
		availableCredits(undefined, [largest, largest], [largest, largest]),
	).toBe(largest);
	expect(addUpper(largest, largest)).toBe(Number.POSITIVE_INFINITY);
});

it.each([
	"reservedCost",
	"reservedUnits",
] as const)("refuses a reservation that would overflow %s without mutating the ledger", (field) => {
	const ledger = createReservationLedger({
		view: "CreditLedgerView",
		seq: 0,
		asOf: "2026-07-01T00:00:00.000Z",
		accounts: [
			{
				providerId: "p",
				dimension: "runner.minutes",
				currency: "USD",
				listUnitCost: 1,
				freeHeadroom: 0,
				[field]: Number.MAX_VALUE,
			},
		],
	});
	const before = ledger.snapshot();
	const result = ledger.reserve({
		providerId: "p",
		dimension: "runner.minutes",
		reservationId: "overflow",
		units: 1,
		expectedSeq: 0,
	});
	expect(result).toMatchObject({
		ok: false,
		status: "ineligible",
		reason: "reservation-overflow",
	});
	expect(ledger.snapshot()).toEqual(before);
	expect(ledger.events()).toEqual([]);
});

it("rejects an unrepresentable quoted cost before changing an uncapped ledger", () => {
	const ledger = createReservationLedger({
		view: "CreditLedgerView",
		seq: 0,
		asOf: "2026-07-01T00:00:00.000Z",
		accounts: [
			{
				providerId: "p",
				dimension: "runner.minutes",
				currency: "USD",
				listUnitCost: Number.MAX_VALUE,
				freeHeadroom: 0,
			},
		],
	});
	const before = ledger.snapshot();
	expect(
		ledger.reserve({
			providerId: "p",
			dimension: "runner.minutes",
			reservationId: "quote-overflow",
			units: 2,
			unitCost: Number.MAX_VALUE,
			expectedSeq: 0,
		}),
	).toMatchObject({ ok: false, status: "ineligible" });
	expect(ledger.snapshot()).toEqual(before);
	expect(ledger.events()).toEqual([]);
});

it("keeps a reservation pending when its final spend cannot be represented", () => {
	const ledger = createReservationLedger({
		view: "CreditLedgerView",
		seq: 0,
		asOf: "2026-07-01T00:00:00.000Z",
		accounts: [
			{
				providerId: "p",
				dimension: "runner.minutes",
				currency: "USD",
				listUnitCost: 0,
				freeHeadroom: 0,
				spendToDate: Number.MAX_VALUE,
			},
		],
	});
	expect(
		ledger.reserve({
			providerId: "p",
			dimension: "runner.minutes",
			reservationId: "overflowing-settlement",
			units: 1,
			expectedSeq: 0,
		}).ok,
	).toBe(true);
	const before = ledger.snapshot();
	const eventsBefore = ledger.events();
	const result = ledger.confirm({
		reservationId: "overflowing-settlement",
		actualCost: Number.MAX_VALUE,
	});
	expect(result).toMatchObject({ ok: false, status: "settlement-overflow" });
	expect(ledger.snapshot()).toEqual(before);
	expect(ledger.events()).toEqual(eventsBefore);
});
