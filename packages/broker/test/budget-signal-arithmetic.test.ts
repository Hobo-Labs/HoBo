import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BUDGET_EVENTS, foldBudgetSignals } from "../src/budget-signals.js";

const usage = (costUsd: number) => ({
	type: "meter.UsageRecorded",
	data: { tenantId: "tenant-a", costUsd },
});
const credit = (amountUsd: number) => ({
	type: BUDGET_EVENTS.CreditApplied,
	data: { tenantId: "tenant-a", amountUsd },
});
const policy = { budgetUsd: 1, tenantId: "tenant-a" };

describe("budget signal decimal arithmetic", () => {
	it("does not cross before spend reaches the exact threshold", () => {
		const result = foldBudgetSignals([usage(0.9999999996)], policy);
		expect(result.state.crossed["1"]).toBe(false);
		expect(result.signals).toEqual([]);
	});

	it("handles thresholds and charges below a nanodollar", () => {
		const tiny = { budgetUsd: 0.0000000006, tenantId: "tenant-a" };
		const below = foldBudgetSignals([usage(0.00000000055)], tiny);
		expect(below.signals).toEqual([]);
		const exact = foldBudgetSignals(
			[usage(0.00000000055), usage(0.00000000005)],
			tiny,
		);
		expect(exact.signals.map((signal) => signal.type)).toEqual([
			BUDGET_EVENTS.ThresholdCrossed,
		]);
		expect(exact.signals[0]?.data.thresholdUsd).toBe(0.0000000006);
	});

	it("emits recovery when a small credit moves spend below the threshold", () => {
		const result = foldBudgetSignals([usage(1), credit(0.0000000004)], policy);
		expect(result.signals.map((signal) => signal.type)).toEqual([
			BUDGET_EVENTS.ThresholdCrossed,
			BUDGET_EVENTS.Recovered,
		]);
	});

	it("sums serialized decimal amounts without binary floating point drift", () => {
		const result = foldBudgetSignals([usage(0.1), usage(0.2)], policy);
		expect(result.state.spentUsd).toBe(0.3);
		expect(result.state.netSpentUsd).toBe(0.3);
	});

	it("refuses a threshold or transition that cannot be represented on the numeric wire", () => {
		expect(() =>
			foldBudgetSignals([], {
				...policy,
				budgetUsd: Number.MIN_VALUE,
				thresholds: [0.1],
			}),
		).toThrow(/precision|represent/iu);
		expect(() =>
			foldBudgetSignals([usage(1), credit(0.00000000000000001)], policy),
		).toThrow(/precision|represent/iu);
	});

	it("matches integer sub-nanodollar threshold decisions across generated histories", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 100 }),
				fc.array(
					fc.record({
						credit: fc.boolean(),
						units: fc.integer({ min: 0, max: 150 }),
					}),
					{ maxLength: 10 },
				),
				(budgetUnits, entries) => {
					let net = 0n;
					let crossed = false;
					const expected: string[] = [];
					for (const entry of entries) {
						net += BigInt(entry.units) * (entry.credit ? -1n : 1n);
						const next = net >= BigInt(budgetUnits);
						if (next !== crossed)
							expected.push(
								next ? BUDGET_EVENTS.ThresholdCrossed : BUDGET_EVENTS.Recovered,
							);
						crossed = next;
					}
					const facts = entries.map((entry) =>
						entry.credit
							? credit(entry.units / 1e10)
							: usage(entry.units / 1e10),
					);
					const actual = foldBudgetSignals(facts, {
						budgetUsd: budgetUnits / 1e10,
						tenantId: "tenant-a",
					});
					expect(actual.signals.map((signal) => signal.type)).toEqual(expected);
					expect(actual.state.crossed["1"]).toBe(crossed);
				},
			),
			{ seed: 614510, numRuns: 500 },
		);
	});
});
