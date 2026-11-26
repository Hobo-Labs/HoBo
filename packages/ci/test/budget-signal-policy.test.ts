import { fromJsonString, type JsonObject } from "@bufbuild/protobuf";
import { foldBudgetSignals } from "@hobo/broker";
import { describe, expect, it } from "vitest";
import { BudgetSignalSchema } from "../src/_generated/ci_pb.js";
import { ciBudgetSignalKey, ciBudgetSignalUpdate } from "../src/policy.js";

const identity = {
	tenantId: "acme",
	budgetId: "ci",
	periodId: "manual-1",
	policyRevision: "r1",
};
function policy(overrides: JsonObject = {}) {
	return {
		tenantId: "acme",
		budgetPolicy: {
			schemaVersion: "hobo.budget-policy/v1",
			tenantId: identity.tenantId,
			budgetId: identity.budgetId,
			periodId: identity.periodId,
			revision: "r1",
			workloads: ["ci"],
			currency: "USD",
			limitMicros: 100_000_000,
			objective: "min-cost",
			enforcement: "conservative",
			periodKind: "manual",
			constraints: [],
			...overrides,
		},
	};
}
function signals(budgetUsd = 100, scope = identity) {
	return foldBudgetSignals(
		[
			{
				type: "meter.UsageRecorded",
				data: {
					tenantId: scope.tenantId,
					budgetId: scope.budgetId,
					periodId: scope.periodId,
					costUsd: budgetUsd,
				},
			},
		],
		{ budgetUsd, identity: scope },
	).signals.map((signal) =>
		fromJsonString(BudgetSignalSchema, JSON.stringify(signal)),
	);
}

describe("shared CI scoped budget signals", () => {
	it("consumes actual Broker reset/crossing with monotonic persisted watermarks", () => {
		const emitted = signals();
		const reset = emitted[0],
			crossing = emitted[1];
		if (!reset || !crossing) throw new Error("fixture signals missing");
		expect(ciBudgetSignalUpdate(reset, policy())).toEqual({
			key: ciBudgetSignalKey(policy(), 1),
			watermark: 1,
			crossed: false,
		});
		expect(ciBudgetSignalUpdate(crossing, policy())).toEqual({
			key: ciBudgetSignalKey(policy(), 1),
			watermark: 2,
			crossed: true,
		});
		const current = ciBudgetSignalUpdate(crossing, policy()).watermark;
		expect(ciBudgetSignalUpdate(reset, policy()).watermark).toBeLessThan(
			current,
		);
	});
	it("does not let delayed prior periods, revisions or budgets control current eligibility", () => {
		const crossing = signals()[1];
		if (!crossing) throw new Error("fixture");
		for (const revised of [
			policy({ periodId: "manual-2" }),
			policy({ revision: "r2" }),
			policy({ budgetId: "another" }),
			policy({ limitMicros: 50_000_000 }),
		])
			expect(() => ciBudgetSignalUpdate(crossing, revised)).toThrow();
	});
	it("represents zero as exhausted and rejects contradictory state", () => {
		const reset = signals(0)[0];
		if (!reset?.data) throw new Error("fixture");
		expect(
			ciBudgetSignalUpdate(reset, policy({ limitMicros: 0 })),
		).toMatchObject({ watermark: 1, crossed: true });
		reset.data.crossed = false;
		expect(() =>
			ciBudgetSignalUpdate(reset, policy({ limitMicros: 0 })),
		).toThrow();
	});
	it("retains explicit legacy compatibility without accepting scoped signals as legacy", () => {
		const legacy = foldBudgetSignals(
			[
				{
					type: "meter.UsageRecorded",
					data: { tenantId: "acme", costUsd: 100 },
				},
			],
			{ tenantId: "acme", budgetUsd: 100 },
		).signals[0];
		if (!legacy) throw new Error("fixture");
		const wire = fromJsonString(BudgetSignalSchema, JSON.stringify(legacy));
		expect(ciBudgetSignalUpdate(wire, { tenantId: "acme" })).toEqual({
			key: "broker:acme:1",
			watermark: 1,
			crossed: true,
		});
		expect(() => ciBudgetSignalUpdate(wire, policy())).toThrow();
	});
});
