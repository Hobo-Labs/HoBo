import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BUDGET_EVENTS, foldBudgetSignals } from "../src/budget-signals.js";

const policy = { budgetUsd: 100, thresholds: [0.5, 1], tenantId: "tenant-a" };
const usage = (costUsd: number) => ({
	type: "meter.UsageRecorded",
	data: { tenantId: "tenant-a", costUsd },
});
const credit = (amountUsd: number) => ({
	type: BUDGET_EVENTS.CreditApplied,
	data: { tenantId: "tenant-a", amountUsd },
});

describe("budget signal history correspondence", () => {
	it("refuses a crossing that cannot be reconstructed from the facts", () => {
		const prior = foldBudgetSignals([usage(120)], policy).signals;
		expect(prior.length).toBeGreaterThan(0);
		expect(() => foldBudgetSignals(prior, policy)).toThrow(
			/signal.*reconcil/iu,
		);
	});

	it("refuses an orphaned recovery even when its crossing still matches", () => {
		const facts = [usage(120), credit(80)];
		const prior = foldBudgetSignals(facts, policy).signals;
		expect(prior.some((entry) => entry.type === BUDGET_EVENTS.Recovered)).toBe(
			true,
		);
		expect(() => foldBudgetSignals([usage(120), ...prior], policy)).toThrow(
			/signal.*reconcil/iu,
		);
	});

	it("does not let a matching crossing hide another orphaned crossing", () => {
		const facts = [usage(60)];
		const matching = foldBudgetSignals(facts, policy).signals;
		const all = foldBudgetSignals([usage(120)], policy).signals;
		const orphan = all.find((signal) => signal.data.thresholdFraction === 1);
		if (!orphan) throw new Error("fixture signal missing");
		expect(() =>
			foldBudgetSignals([...facts, ...matching, orphan], policy),
		).toThrow(/signal.*reconcil/iu);
	});

	it("refuses orphaned versioned transitions while preserving the reset", () => {
		const identity = {
			tenantId: "tenant-a",
			budgetId: "hosting",
			periodId: "p1",
			policyRevision: "r1",
		};
		const scoped = { budgetUsd: 100, identity };
		const fact = {
			type: "meter.UsageRecorded",
			data: {
				tenantId: "tenant-a",
				budgetId: "hosting",
				periodId: "p1",
				costUsd: 120,
			},
		};
		const prior = foldBudgetSignals([fact], scoped).signals;
		expect(prior.map((signal) => signal.type)).toEqual([
			BUDGET_EVENTS.StateReset,
			BUDGET_EVENTS.ThresholdCrossed,
		]);
		expect(() => foldBudgetSignals(prior, scoped)).toThrow(
			/signal.*reconcil/iu,
		);
	});

	it("allows independently scoped foreign history even if its facts are elsewhere", () => {
		const foreign = foldBudgetSignals(
			[
				{
					type: "meter.UsageRecorded",
					data: { tenantId: "tenant-b", costUsd: 120 },
				},
			],
			{ ...policy, tenantId: "tenant-b" },
		).signals;
		expect(foldBudgetSignals([usage(60), ...foreign], policy).signals).toEqual(
			foldBudgetSignals([usage(60)], policy).signals,
		);
	});

	it("rejects changed or orphaned recorded transitions in generated histories", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						isCredit: fc.boolean(),
						amount: fc.integer({ min: 0, max: 150 }),
					}),
					{ minLength: 1, maxLength: 8 },
				),
				fc.nat(),
				(entries, drop) => {
					const facts = entries.map(({ isCredit, amount }) =>
						isCredit ? credit(amount) : usage(amount),
					);
					const original = foldBudgetSignals(facts, policy).signals;
					const retained = facts.filter(
						(_, index) => index !== drop % facts.length,
					);
					const reconstructed = foldBudgetSignals(retained, policy).signals;
					const stale = original.some((signal) => {
						const match = reconstructed.find(
							(candidate) => candidate.data.signalKey === signal.data.signalKey,
						);
						return !match || JSON.stringify(match) !== JSON.stringify(signal);
					});
					if (stale)
						expect(() =>
							foldBudgetSignals([...retained, ...original], policy),
						).toThrow(/signal.*(conflict|reconcil)/iu);
					else
						expect(() =>
							foldBudgetSignals([...retained, ...original], policy),
						).not.toThrow();
				},
			),
			{ seed: 614509, numRuns: 500 },
		);
	});
});
