import fc from "fast-check";
import { expect, it } from "vitest";
import { createReservationLedger } from "../src/dispatcher.js";

type ConsumptionFixture = {
	freeHeadroom?: number;
	rateUnits?: number;
	concurrencySlots?: number;
	credits?: { creditId: string; units: number }[] | string;
};
const snapshot = (consumption: ConsumptionFixture, units = 1) => ({
	view: "CreditLedgerView",
	seq: 1,
	accounts: [
		{
			providerId: "p",
			dimension: "runner.minutes",
			freeHeadroom: 0,
			rateHeadroom: 0,
			concurrencyHeadroom: 0,
			reservedUnits: units,
			reservedCost: 0,
			budgetCap: 10,
			listUnitCost: 1,
		},
	],
	reservations: [
		{
			reservationId: "r",
			providerId: "p",
			dimension: "runner.minutes",
			units,
			expectedSeq: 0,
			committedSeq: 1,
			status: "pending",
			reservedCost: 0,
			consumption,
		},
	],
});
it.each([
	{ freeHeadroom: 2, rateUnits: 1, concurrencySlots: 1, credits: [] },
	{ freeHeadroom: 1, rateUnits: 2, concurrencySlots: 1, credits: [] },
	{ freeHeadroom: 1, rateUnits: 1, concurrencySlots: 2, credits: [] },
	{ freeHeadroom: 1, rateUnits: 1, concurrencySlots: 0.5, credits: [] },
	{ freeHeadroom: -1, credits: [] },
	{ freeHeadroom: 1, credits: [{ creditId: "c", units: 2 }] },
	{
		freeHeadroom: 0,
		credits: [
			{ creditId: "a", units: 0.7 },
			{ creditId: "b", units: 0.7 },
		],
	},
	{
		freeHeadroom: 1,
		credits: [
			{ creditId: "c", units: 0.4 },
			{ creditId: "c", units: 0.4 },
		],
	},
	{ freeHeadroom: 1, credits: [{ creditId: "c", units: -1 }] },
	{ freeHeadroom: 1, credits: "not-an-array" },
	{ freeHeadroom: 1, credits: "" },
])("rejects an imported reservation with invalid consumption: %j", (consumption) => {
	expect(() => createReservationLedger(snapshot(consumption))).toThrow(
		/consumption/i,
	);
});
it("restores a valid reserved quantity once", () => {
	const ledger = createReservationLedger(
		snapshot({
			freeHeadroom: 1,
			rateUnits: 1,
			concurrencySlots: 1,
			credits: [],
		}),
	);
	expect(ledger.release({ reservationId: "r" }).ok).toBe(true);
	expect(ledger.snapshot().accounts[0]).toMatchObject({
		freeHeadroom: 1,
		rateHeadroom: 1,
		concurrencyHeadroom: 1,
	});
	expect(ledger.release({ reservationId: "r" }).ok).toBe(false);
	expect(ledger.snapshot().accounts[0]).toMatchObject({
		freeHeadroom: 1,
		rateHeadroom: 1,
		concurrencyHeadroom: 1,
	});
});
it("rejects generated consumption greater than its reservation", () => {
	fc.assert(
		fc.property(
			fc.integer({ min: 1, max: 100 }),
			fc.integer({ min: 1, max: 100 }),
			(units, excess) => {
				for (const consumption of [
					{ freeHeadroom: units + excess, credits: [] },
					{ freeHeadroom: 0, rateUnits: units + excess, credits: [] },
					{
						freeHeadroom: 0,
						credits: [{ creditId: "c", units: units + excess }],
					},
				])
					expect(() =>
						createReservationLedger(snapshot(consumption, units)),
					).toThrow(/consumption/i);
			},
		),
		{ seed: 614474, numRuns: 100 },
	);
});
it("reimports generated fractional credit consumption produced by the ledger", () => {
	const amount = fc.double({
		min: 1e-10,
		max: 1,
		noNaN: true,
		noDefaultInfinity: true,
	});
	fc.assert(
		fc.property(
			amount,
			fc.array(amount, { minLength: 1, maxLength: 6 }),
			(units, grants) => {
				const ledger = createReservationLedger({
					view: "CreditLedgerView",
					seq: 0,
					asOf: "2026-07-01T00:00:00.000Z",
					accounts: [
						{
							providerId: "p",
							dimension: "runner.minutes",
							budgetCap: 10,
							listUnitCost: 1,
							credits: grants.map((freeHeadroom, index) => ({
								creditId: `g${index}`,
								freeHeadroom,
							})),
						},
					],
				});
				const result = ledger.reserve({
					providerId: "p",
					dimension: "runner.minutes",
					reservationId: "r",
					units,
					expectedSeq: 0,
				});
				expect(result.ok).toBe(true);
				expect(() => createReservationLedger(ledger.snapshot())).not.toThrow();
			},
		),
		{ seed: 614475, numRuns: 300 },
	);
});
