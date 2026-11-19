import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json.js";
import {
	type BudgetPolicyEvaluationContext,
	evaluateBudgetPolicy,
	parseBudgetPolicy,
} from "../src/ports/budget-policy.js";

const CHECK = { seed: 614438, numRuns: 500 };
const safeAmount = fc.oneof(
	fc.integer({ min: 0, max: 1_000_000 }),
	fc.constantFrom(0, 1, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER),
);

function policy(limitMicros: number, extra: JsonObject = {}) {
	return parseBudgetPolicy({
		schemaVersion: "hobo.budget-policy/v1",
		tenantId: "tenant",
		budgetId: "budget",
		periodId: "period",
		revision: "revision",
		workloads: ["ci", "hosting"],
		currency: "USD",
		limitMicros,
		objective: "min-cost",
		enforcement: "conservative",
		periodKind: "manual",
		constraints: [],
		...extra,
	});
}

function context(
	patch: Partial<BudgetPolicyEvaluationContext> = {},
): BudgetPolicyEvaluationContext {
	return {
		workload: "ci",
		tenantId: "tenant",
		budgetId: "budget",
		periodId: "period",
		policyRevision: "revision",
		nowMs: 1_000,
		costBoundMicros: 0,
		exposureMicros: 0,
		boundKind: "conservative",
		phase: "admit",
		measurements: [],
		...patch,
	};
}

describe("shared budget-policy properties", () => {
	it("rejects non-array constraints instead of silently dropping them", () => {
		fc.assert(
			fc.property(fc.constantFrom(null, false, 0, "", {}), (constraints) => {
				expect(() => policy(100, { constraints })).toThrow();
			}),
			CHECK,
		);
	});

	it("refuses malformed measurement collections and records", () => {
		const invalidCollection = fc.constantFrom(
			null,
			false,
			0,
			"",
			{},
			undefined,
		);
		const invalidRecord = fc.constantFrom(
			null,
			false,
			{},
			{ key: 7, unit: "count", value: 0 },
			{ key: "work.count", unit: null, value: 0 },
			{ key: "work.count", unit: "count", value: 0, target: 7 },
			{ key: "unqualified", unit: "count", value: 0 },
			{ key: "work.count", unit: "", value: 0 },
		);
		fc.assert(
			fc.property(
				fc.oneof(
					invalidCollection,
					fc.array(invalidRecord, { minLength: 1, maxLength: 3 }),
				),
				(measurements) => {
					const input = JSON.parse(
						JSON.stringify({ ...context(), measurements }),
					);
					const result = evaluateBudgetPolicy(policy(100), input);
					expect(result).toMatchObject({
						ok: false,
						code: "budget.policy.measurement",
					});
				},
			),
			CHECK,
		);
	});

	it.each([
		null,
		undefined,
		0,
		"",
		[],
	])("refuses a malformed evaluation context: %j", (value) => {
		const input = JSON.parse(JSON.stringify({ value })).value;
		const result = evaluateBudgetPolicy(policy(100), input);
		expect(result).toMatchObject({ ok: false, code: "budget.policy.context" });
	});

	it("uses exact integer arithmetic for all generated safe-integer exposure and limits", () => {
		fc.assert(
			fc.property(
				safeAmount,
				safeAmount,
				safeAmount,
				(limit, exposure, quote) => {
					const result = evaluateBudgetPolicy(
						policy(limit),
						context({ exposureMicros: exposure, costBoundMicros: quote }),
					);
					const expected = BigInt(exposure) + BigInt(quote) <= BigInt(limit);
					expect(result.ok).toBe(expected);
					if (result.ok) {
						expect(result.projectedMicros).toBe(exposure + quote);
						expect(result.remainingMicros).toBe(limit - exposure - quote);
					}
				},
			),
			CHECK,
		);
	});

	it("never admits a strict policy without a native bound, while flagging feasible plans", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 1_000_000 }),
				fc.integer({ min: 0, max: 1_000_000 }),
				(limit, exposure) => {
					const strict = policy(limit, { enforcement: "strict" });
					const plan = evaluateBudgetPolicy(
						strict,
						context({ phase: "plan", exposureMicros: exposure }),
					);
					const admission = evaluateBudgetPolicy(
						strict,
						context({ phase: "admit", exposureMicros: exposure }),
					);
					expect(admission.ok).toBe(false);
					expect(plan.ok).toBe(exposure <= limit);
					if (plan.ok) expect(plan.requiresNativeBound).toBe(true);
				},
			),
			CHECK,
		);
	});

	it("rejects foreign scope and missing, mismatched, or excessive required metrics", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 1_000_000 }),
				fc.integer({ min: 0, max: 1_000_000 }),
				(maximum, measured) => {
					const constrained = policy(1_000_000, {
						constraints: [
							{
								key: "work.concurrent",
								workload: "ci",
								unit: "count",
								maximum,
							},
						],
					});
					const measurement = {
						key: "work.concurrent",
						unit: "count",
						value: measured,
					};
					expect(evaluateBudgetPolicy(constrained, context()).ok).toBe(false);
					expect(
						evaluateBudgetPolicy(
							constrained,
							context({ measurements: [{ ...measurement, unit: "ms" }] }),
						).ok,
					).toBe(false);
					expect(
						evaluateBudgetPolicy(
							constrained,
							context({ measurements: [measurement] }),
						).ok,
					).toBe(measured <= maximum);
					expect(
						evaluateBudgetPolicy(
							constrained,
							context({ tenantId: "foreign", measurements: [measurement] }),
						).ok,
					).toBe(false);
				},
			),
			CHECK,
		);
	});

	it("admits fixed-window work only within the window and when its duration fits", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 1_000 }),
				fc.integer({ min: 1, max: 1_000 }),
				fc.integer({ min: 0, max: 3_000 }),
				fc.integer({ min: 0, max: 1_000 }),
				(start, length, nowMs, duration) => {
					const end = start + length;
					const window = policy(1, {
						periodKind: "fixed-window",
						periodStartsAtMs: start,
						periodEndsAtMs: end,
					});
					const result = evaluateBudgetPolicy(
						window,
						context({
							nowMs,
							measurements: [
								{ key: "work.duration", unit: "ms", value: duration },
							],
						}),
					);
					expect(result.ok).toBe(
						nowMs >= start && nowMs < end && nowMs + duration <= end,
					);
				},
			),
			CHECK,
		);
	});
});
