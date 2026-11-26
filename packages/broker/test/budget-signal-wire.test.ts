import { create, fromJsonString } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	BudgetIdentitySchema,
	budgetIdentityKey,
} from "../src/budget-authority.js";
import {
	BUDGET_EVENTS,
	budgetSignalEventInputs,
	foldBudgetSignals,
} from "../src/budget-signals.js";
import { METER_USAGE_RECORDED_EVENT } from "../src/metering.js";

const identity = {
	tenantId: "tenant-a",
	budgetId: "shared",
	periodId: "2026-10",
	policyRevision: "r1",
};

describe("public budget signal wire", () => {
	it("serializes actual fold output without protobuf metadata and preserves replay keys", () => {
		const generatedIdentity = create(BudgetIdentitySchema, identity);
		const policy = { budgetUsd: 100, identity: generatedIdentity };
		const facts = [
			{
				type: METER_USAGE_RECORDED_EVENT,
				data: { ...identity, costUsd: 120 },
			},
			{
				type: BUDGET_EVENTS.CreditApplied,
				data: { ...identity, amountUsd: 80 },
			},
		];
		const { signals } = foldBudgetSignals(facts, policy);
		expect(signals.map((signal) => signal.type)).toEqual([
			BUDGET_EVENTS.StateReset,
			BUDGET_EVENTS.ThresholdCrossed,
			BUDGET_EVENTS.Recovered,
		]);
		const serialized = JSON.stringify(signals);
		expect(serialized).not.toContain("$typeName");
		expect(serialized).not.toContain("$unknown");
		for (const signal of signals) {
			expect(signal.data.identity).toEqual(identity);
			expect(
				fromJsonString(
					BudgetIdentitySchema,
					JSON.stringify(signal.data.identity),
				),
			).toEqual(generatedIdentity);
		}
		const keyIdentity = encodeURIComponent(
			JSON.stringify(["tenant-a", "shared", "2026-10", "r1"]),
		);
		expect(signals.map((signal) => signal.data.signalKey)).toEqual([
			`budget:v2:${keyIdentity}:1:reset:0`,
			`budget:v2:${keyIdentity}:1:crossed:1`,
			`budget:v2:${keyIdentity}:1:recovered:2`,
		]);
		expect(
			foldBudgetSignals([...facts, ...JSON.parse(serialized)], policy).signals,
		).toEqual([]);
		expect(JSON.stringify(budgetSignalEventInputs(signals))).not.toContain(
			"$typeName",
		);
	});

	it("retains the canonical four-field authority identity key", () => {
		expect(budgetIdentityKey(create(BudgetIdentitySchema, identity))).toBe(
			JSON.stringify(["tenant-a", "shared", "2026-10", "r1"]),
		);
		expect(() =>
			budgetIdentityKey(create(BudgetIdentitySchema, { tenantId: "tenant-a" })),
		).toThrow();
		expect(() =>
			foldBudgetSignals([], {
				budgetUsd: 100,
				identity: JSON.parse('{"tenantId":"tenant-a"}'),
			}),
		).toThrow();
	});
});
