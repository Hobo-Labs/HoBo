/**
 * Estimate versus actual.
 *
 * Written before the implementation. The whole claim of HOBO-819's sibling gap
 * (N4) is that HoBo holds both halves — what a plan said a deployment would
 * cost, and what it actually cost — and never compares them. Infracost
 * estimates and never sees the bill; Kubecost, Vantage and OpenCost measure the
 * bill and never see the estimate. Nobody closes the loop, so nobody can learn
 * that their estimates are systematically wrong.
 *
 * The rules these tests hold are the ones that decide whether a finance team
 * believes the number:
 *
 *   - **It must sum to the invoice.** An actual with no matching estimate is
 *     reported as unestimated, never dropped. OpenCost's idle-as-residual
 *     design exists because a cost surface that quietly omits a line is a cost
 *     surface nobody trusts twice.
 *   - **A short window is not a saving.** Three days of actuals against a
 *     month's estimate is a 90% "underspend" that is entirely an artifact.
 *     Comparing them at all is the bug.
 *   - **An estimate for something never built is not an underspend.** It is an
 *     estimate that was never tested, and the two must not be added together.
 *   - **Integer minor units, one currency.** Floating-point USD accumulates
 *     error, and a total that disagrees with the invoice by a cent is a total
 *     that gets the whole surface disbelieved.
 */
import { describe, expect, it } from "vitest";

import {
	type ActualCost,
	type CostReconciliationInput,
	type EstimatedCost,
	reconcileCost,
} from "../src/projections/cost-reconciliation.js";

function estimate(
	resource: string,
	minorUnits: number,
	overrides: Partial<EstimatedCost> = {},
): EstimatedCost {
	return { resource, minorUnits, ...overrides };
}

function actual(
	resource: string,
	minorUnits: number,
	overrides: Partial<ActualCost> = {},
): ActualCost {
	return { resource, minorUnits, ...overrides };
}

function inputs(
	overrides: Partial<CostReconciliationInput> = {},
): CostReconciliationInput {
	return {
		deploymentId: "d1",
		currency: "USD",
		estimatePeriodMs: 30 * 24 * 60 * 60 * 1000,
		observedWindowMs: 30 * 24 * 60 * 60 * 1000,
		estimated: [estimate("web", 10_000)],
		actual: [actual("web", 10_000)],
		...overrides,
	};
}

describe("an estimate that held", () => {
	it("reports zero variance when actuals match", () => {
		const report = reconcileCost(inputs());
		expect(report.status).toBe("reconciled");
		expect(report.totals.varianceMinorUnits).toBe(0);
		expect(report.findings).toEqual([]);
	});

	it("carries both totals so the report can be checked against the invoice", () => {
		const report = reconcileCost(
			inputs({
				estimated: [estimate("web", 10_000), estimate("db", 5_000)],
				actual: [actual("web", 10_000), actual("db", 5_000)],
			}),
		);
		expect(report.totals.estimatedMinorUnits).toBe(15_000);
		expect(report.totals.actualMinorUnits).toBe(15_000);
	});
});

describe("variance", () => {
	it("reports an overspend as a positive variance", () => {
		const report = reconcileCost(inputs({ actual: [actual("web", 13_000)] }));
		expect(report.totals.varianceMinorUnits).toBe(3_000);
		expect(report.status).toBe("over");
	});

	it("reports an underspend as a negative variance", () => {
		const report = reconcileCost(inputs({ actual: [actual("web", 7_000)] }));
		expect(report.totals.varianceMinorUnits).toBe(-3_000);
		expect(report.status).toBe("under");
	});

	it("names the resource that diverged", () => {
		const report = reconcileCost(
			inputs({
				estimated: [estimate("web", 10_000), estimate("db", 5_000)],
				actual: [actual("web", 10_000), actual("db", 9_000)],
			}),
		);
		expect(report.findings.map((f) => `${f.kind}:${f.resource}`)).toEqual([
			"variance:db",
		]);
	});

	it("does not report a divergence inside the tolerance", () => {
		// Metered billing rounds. A report that fires on every cent is a report
		// with an ignore-list bolted on by the second week.
		const report = reconcileCost(
			inputs({ actual: [actual("web", 10_050)], toleranceBasisPoints: 100 }),
		);
		expect(report.findings).toEqual([]);
		expect(report.status).toBe("reconciled");
	});

	it("reports a divergence just outside the tolerance", () => {
		const report = reconcileCost(
			inputs({ actual: [actual("web", 10_150)], toleranceBasisPoints: 100 }),
		);
		expect(report.findings).toHaveLength(1);
	});

	it("defaults to no tolerance, so an exact comparison is the default", () => {
		const report = reconcileCost(inputs({ actual: [actual("web", 10_001)] }));
		expect(report.findings).toHaveLength(1);
	});
});

describe("actuals with no estimate", () => {
	it("reports them rather than dropping them", () => {
		// The line that decides whether finance believes the total. A surface
		// that silently omits a charge is one nobody trusts twice.
		const report = reconcileCost(
			inputs({ actual: [actual("web", 10_000), actual("mystery", 4_000)] }),
		);
		expect(report.findings.map((f) => f.kind)).toEqual(["unestimated"]);
		expect(report.totals.actualMinorUnits).toBe(14_000);
		expect(report.status).toBe("over");
	});

	it("counts unestimated cost toward the total, not beside it", () => {
		const report = reconcileCost(
			inputs({ actual: [actual("web", 10_000), actual("mystery", 4_000)] }),
		);
		expect(report.totals.varianceMinorUnits).toBe(4_000);
		expect(report.totals.unestimatedMinorUnits).toBe(4_000);
	});
});

describe("estimates for resources that never materialized", () => {
	it("reports them separately rather than as an underspend", () => {
		// An estimate that was never tested is not a saving. Adding it to the
		// variance would let a failed deployment look like good cost control.
		const report = reconcileCost(
			inputs({
				estimated: [estimate("web", 10_000), estimate("ghost", 6_000)],
				actual: [actual("web", 10_000)],
			}),
		);
		expect(report.findings.map((f) => `${f.kind}:${f.resource}`)).toEqual([
			"unrealized:ghost",
		]);
		expect(report.totals.unrealizedMinorUnits).toBe(6_000);
	});

	it("excludes unrealized estimates from the variance", () => {
		const report = reconcileCost(
			inputs({
				estimated: [estimate("web", 10_000), estimate("ghost", 6_000)],
				actual: [actual("web", 10_000)],
			}),
		);
		expect(report.totals.varianceMinorUnits).toBe(0);
		expect(report.status).toBe("reconciled");
	});

	it("still counts them in the estimated total, which is what was promised", () => {
		const report = reconcileCost(
			inputs({
				estimated: [estimate("web", 10_000), estimate("ghost", 6_000)],
				actual: [actual("web", 10_000)],
			}),
		);
		expect(report.totals.estimatedMinorUnits).toBe(16_000);
	});
});

describe("the observed window", () => {
	it("refuses to compare a partial window against a full-period estimate", () => {
		// Three days against a month is a 90% "saving" that is entirely an
		// artifact of the clock.
		const report = reconcileCost(
			inputs({
				observedWindowMs: 3 * 24 * 60 * 60 * 1000,
				actual: [actual("web", 1_000)],
			}),
		);
		expect(report.status).toBe("insufficient-window");
		expect(report.findings).toEqual([]);
	});

	it("still reports both totals when the window is short", () => {
		// Refusing the comparison is not refusing the facts.
		const report = reconcileCost(
			inputs({
				observedWindowMs: 3 * 24 * 60 * 60 * 1000,
				actual: [actual("web", 1_000)],
			}),
		);
		expect(report.totals.estimatedMinorUnits).toBe(10_000);
		expect(report.totals.actualMinorUnits).toBe(1_000);
		expect(report.totals.varianceMinorUnits).toBeUndefined();
	});

	it("compares when the window covers the estimate period", () => {
		const report = reconcileCost(inputs());
		expect(report.status).toBe("reconciled");
	});

	it("compares when the window exceeds the estimate period", () => {
		const report = reconcileCost(
			inputs({ observedWindowMs: 45 * 24 * 60 * 60 * 1000 }),
		);
		expect(report.status).not.toBe("insufficient-window");
	});

	it("reports coverage so a caller can say how complete the comparison is", () => {
		const report = reconcileCost(
			inputs({ observedWindowMs: 15 * 24 * 60 * 60 * 1000 }),
		);
		expect(report.coverage).toBeCloseTo(0.5, 5);
	});
});

describe("currency", () => {
	it("refuses to reconcile actuals in a different currency", () => {
		// Summing two currencies produces a number that is wrong in a way no
		// reader can see. Refusing is the only honest answer without an FX rate.
		const report = reconcileCost(
			inputs({ actual: [actual("web", 10_000, { currency: "EUR" })] }),
		);
		expect(report.status).toBe("currency-mismatch");
		expect(report.totals.varianceMinorUnits).toBeUndefined();
	});

	it("accepts actuals that omit the currency, taking the report's", () => {
		expect(reconcileCost(inputs()).status).toBe("reconciled");
	});
});

describe("report shape", () => {
	it("orders findings by resource name so the report is stable", () => {
		const report = reconcileCost(
			inputs({
				estimated: [estimate("c", 100), estimate("a", 100)],
				actual: [actual("c", 200), actual("a", 200), actual("b", 50)],
			}),
		);
		expect(report.findings.map((f) => f.resource)).toEqual(["a", "b", "c"]);
	});

	it("carries the deployment id and currency", () => {
		const report = reconcileCost(inputs());
		expect(report.deploymentId).toBe("d1");
		expect(report.currency).toBe("USD");
	});

	it("gives each variance finding both sides and the difference", () => {
		const [finding] = reconcileCost(
			inputs({ actual: [actual("web", 12_500)] }),
		).findings;
		expect(finding).toMatchObject({
			kind: "variance",
			resource: "web",
			estimatedMinorUnits: 10_000,
			actualMinorUnits: 12_500,
			varianceMinorUnits: 2_500,
		});
	});

	it("is a pure function of its input", () => {
		const input = inputs({
			estimated: [estimate("web", 10_000), estimate("ghost", 500)],
			actual: [actual("web", 12_000), actual("extra", 300)],
		});
		expect(reconcileCost(input)).toEqual(reconcileCost(input));
	});

	it("does not mutate its input", () => {
		const input = inputs({
			estimated: [estimate("b", 1), estimate("a", 2)],
			actual: [actual("b", 3)],
		});
		const before = structuredClone(input);
		reconcileCost(input);
		expect(input).toEqual(before);
	});

	it("reconciles an empty deployment to zero rather than failing", () => {
		const report = reconcileCost(inputs({ estimated: [], actual: [] }));
		expect(report.status).toBe("reconciled");
		expect(report.totals).toMatchObject({
			estimatedMinorUnits: 0,
			actualMinorUnits: 0,
			varianceMinorUnits: 0,
		});
	});

	it("sums repeated actual lines for one resource", () => {
		// A metered bill arrives as many lines per resource, not one.
		const report = reconcileCost(
			inputs({ actual: [actual("web", 6_000), actual("web", 4_000)] }),
		);
		expect(report.totals.actualMinorUnits).toBe(10_000);
		expect(report.findings).toEqual([]);
	});
});
