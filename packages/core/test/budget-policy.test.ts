import { create, toJsonString } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { BudgetPolicyRecordSchema } from "../src/_generated/budget_policy_pb.js";
import {
	type BudgetPolicyEvaluationContext,
	budgetScopeIdentityKey,
	budgetThresholdSignalKey,
	canonicalBudgetPolicyJson,
	evaluateBudgetPolicy,
	parseBudgetPolicy,
	parseBudgetPolicyDocumentJson,
	parseBudgetPolicyJson,
} from "../src/ports/budget-policy.js";

function authored() {
	return {
		schemaVersion: "hobo.budget-policy/v1",
		tenantId: "team",
		budgetId: "engineering",
		periodId: "period-1",
		revision: "revision-1",
		workloads: ["hosting", "ci"],
		currency: "USD",
		limitMicros: 100,
		objective: "min-cost",
		enforcement: "conservative",
		periodKind: "manual",
		constraints: [
			{ key: "work.cost", workload: "*", unit: "USD.micros", maximum: 60 },
		],
	};
}
function context(
	patch: Partial<BudgetPolicyEvaluationContext> = {},
): BudgetPolicyEvaluationContext {
	return {
		workload: "ci",
		tenantId: "team",
		budgetId: "engineering",
		periodId: "period-1",
		policyRevision: "revision-1",
		nowMs: 1000,
		costBoundMicros: 60,
		exposureMicros: 40,
		boundKind: "conservative",
		measurements: [],
		...patch,
	};
}

describe("shared budget policy authored contract", () => {
	it("round-trips a single immutable policy across hosting and CI", () => {
		const input = authored();
		const policy = parseBudgetPolicy(input);
		input.workloads.push("untrusted");
		const first = input.constraints[0];
		if (!first) throw new Error("fixture requires a work-cost constraint");
		first.maximum = 1000;
		expect(policy.workloads).toEqual(["hosting", "ci"]);
		expect(policy.constraints[0]?.maximum).toBe(60);
		expect(Object.isFrozen(policy)).toBe(true);
		expect(Object.isFrozen(policy.workloads)).toBe(true);
		expect(Object.isFrozen(policy.constraints[0])).toBe(true);
		expect(parseBudgetPolicyJson(JSON.stringify(policy))).toEqual(policy);
		for (const workload of ["ci", "hosting"])
			expect(evaluateBudgetPolicy(policy, context({ workload })).ok).toBe(true);
	});
	it("canonicalizes set order while binding every control", () => {
		const first = {
			...authored(),
			constraints: [
				...authored().constraints,
				{
					key: "provider.cost",
					workload: "ci",
					unit: "USD.micros",
					maximum: 80,
					target: "payer-A",
				},
			],
		};
		const second = {
			...first,
			workloads: [...first.workloads].reverse(),
			constraints: [...first.constraints].reverse(),
		};
		const canonical = canonicalBudgetPolicyJson(parseBudgetPolicy(first));
		expect(canonicalBudgetPolicyJson(parseBudgetPolicy(second))).toBe(
			canonical,
		);
		for (const changed of [
			{ ...first, limitMicros: 101 },
			{ ...first, revision: "revision-2" },
			{ ...first, periodId: "period-2" },
			{ ...first, objective: "maximize-credits" },
			{ ...first, enforcement: "strict" },
			{
				...first,
				constraints: [
					{ key: "work.cost", workload: "*", unit: "USD.micros", maximum: 59 },
				],
			},
		])
			expect(canonicalBudgetPolicyJson(parseBudgetPolicy(changed))).not.toBe(
				canonical,
			);
	});
	it.each([
		{ ...authored(), schemaVersion: "hobo.budget-policy/v2" },
		{ ...authored(), currency: "EUR" },
		{ ...authored(), limitMicros: -1 },
		{ ...authored(), limitMicros: 1.5 },
		{ ...authored(), limitMicros: 9007199254740992 },
		{ ...authored(), tenantId: "" },
		{ ...authored(), tenantId: "team\nother" },
		{ ...authored(), objective: "cheapest-sounding" },
		{ ...authored(), enforcement: "optional" },
		{ ...authored(), workloads: [] },
		{ ...authored(), workloads: ["ci", "ci"] },
		{ ...authored(), periodKind: "calendar-month" },
		{ ...authored(), periodEndsAtMs: 2000 },
		{ ...authored(), spentMicros: 0 },
		{ ...authored(), creditBalance: 100 },
		{ ...authored(), limit_micros: 999 },
		{
			...authored(),
			constraints: [
				{
					key: "work.cost",
					workload: "ci",
					unit: "USD.micros",
					maximum: 1,
					optional: true,
				},
			],
		},
		{
			...authored(),
			constraints: [
				{ key: "work.cost", workload: "other", unit: "USD.micros", maximum: 1 },
			],
		},
		{
			...authored(),
			constraints: [...authored().constraints, ...authored().constraints],
		},
	])("rejects ambiguous, runtime-owned or unsupported controls %#", (input) => {
		expect(() => parseBudgetPolicy(input)).toThrow();
	});
	it("requires explicit monetary and constraint zero rather than protobuf defaults", () => {
		const { limitMicros: _limit, ...missing } = authored();
		expect(() => parseBudgetPolicy(missing)).toThrow();
		const zero = { ...authored(), limitMicros: 0, constraints: [] };
		expect(parseBudgetPolicy(zero).limitMicros).toBe(0);
		expect(
			evaluateBudgetPolicy(
				parseBudgetPolicy(zero),
				context({ exposureMicros: 0, costBoundMicros: 0 }),
			).ok,
		).toBe(true);
		expect(
			evaluateBudgetPolicy(
				parseBudgetPolicy(zero),
				context({ exposureMicros: 0, costBoundMicros: 1 }),
			).ok,
		).toBe(false);
	});
	it("preserves explicit zero ceilings through the generated protobuf JSON contract", () => {
		const zero = {
			...authored(),
			limitMicros: 0,
			constraints: [
				{ key: "work.cost", workload: "*", unit: "USD.micros", maximum: 0 },
			],
		};
		const wire = create(BudgetPolicyRecordSchema, zero);
		const parsed = parseBudgetPolicyJson(
			toJsonString(BudgetPolicyRecordSchema, wire),
		);
		expect(parsed.limitMicros).toBe(0);
		expect(parsed.constraints[0]?.maximum).toBe(0);
		expect(
			evaluateBudgetPolicy(
				parsed,
				context({ costBoundMicros: 0, exposureMicros: 0 }),
			).ok,
		).toBe(true);
	});
});

describe("policy JSON boundary", () => {
	it.each([
		'{"limitMicros":1,"limitMicros":100}',
		'{"budgetPolicy":{"limitMicros":1,"limit\\u004dicros":100}}',
		'{"providers":[{"enabled":false,"enabled":true}]}',
	])("rejects duplicate and escaped control keys before protobuf normalization", (text) => {
		expect(() => parseBudgetPolicyDocumentJson(text)).toThrow("duplicate");
	});
	it("accepts escaped strings, arrays and equivalent JSON object key spellings", () => {
		const value = { 'quoted"key': ["\\", { line: "\n" }, 1, true, null] };
		expect(parseBudgetPolicyDocumentJson(JSON.stringify(value))).toEqual(value);
	});
	it("bounds document size and nesting without an external parser", () => {
		expect(() =>
			parseBudgetPolicyDocumentJson(`"${"x".repeat(262144)}"`),
		).toThrow("large");
		expect(() =>
			parseBudgetPolicyDocumentJson(`${"[".repeat(34)}0${"]".repeat(34)}`),
		).toThrow("nesting");
		expect(() => parseBudgetPolicyDocumentJson("{not json}")).toThrow(
			"valid JSON",
		);
	});
});

describe("pure financial feasibility and required domain metrics", () => {
	it("includes all existing exposure and preserves exact micros", () => {
		const policy = parseBudgetPolicy(authored());
		expect(evaluateBudgetPolicy(policy, context())).toMatchObject({
			ok: true,
			projectedMicros: 100,
			remainingMicros: 0,
		});
		expect(
			evaluateBudgetPolicy(policy, context({ exposureMicros: 41 })).code,
		).toBe("budget.policy.exhausted");
		expect(
			evaluateBudgetPolicy(
				policy,
				context({ costBoundMicros: 61, exposureMicros: 0 }),
			).code,
		).toBe("budget.policy.constraint");
		expect(
			evaluateBudgetPolicy(
				policy,
				context({
					costBoundMicros: Number.MAX_SAFE_INTEGER,
					exposureMicros: Number.MAX_SAFE_INTEGER,
				}),
			).ok,
		).toBe(false);
	});
	it.each([
		"tenantId",
		"budgetId",
		"periodId",
		"policyRevision",
	] as const)("refuses foreign %s", (field) => {
		expect(
			evaluateBudgetPolicy(
				parseBudgetPolicy(authored()),
				context({ [field]: "foreign" }),
			).code,
		).toBe("budget.policy.scope");
	});
	it("does not confuse pure planning with native financial admission", () => {
		const strict = parseBudgetPolicy({ ...authored(), enforcement: "strict" });
		expect(
			evaluateBudgetPolicy(strict, context({ phase: "plan" })),
		).toMatchObject({ ok: true, requiresNativeBound: true });
		expect(evaluateBudgetPolicy(strict, context()).code).toBe(
			"budget.policy.native-bound",
		);
		expect(
			evaluateBudgetPolicy(strict, context({ boundKind: "native" })),
		).toMatchObject({ ok: true, requiresNativeBound: false });
	});
	it("refuses a lying derived work cost or duplicate projected metric", () => {
		const policy = parseBudgetPolicy(authored());
		const measurements = [{ key: "work.cost", unit: "USD.micros", value: 1 }];
		expect(evaluateBudgetPolicy(policy, context({ measurements })).code).toBe(
			"budget.policy.measurement",
		);
		expect(
			evaluateBudgetPolicy(
				policy,
				context({ measurements: [...measurements, ...measurements] }),
			).ok,
		).toBe(false);
	});
	it("supports a future workload metric only when its adapter supplies that exact unit", () => {
		const policy = parseBudgetPolicy({
			...authored(),
			workloads: ["ci", "batch.gpu"],
			constraints: [
				{
					key: "acme.gpu.time",
					workload: "batch.gpu",
					unit: "gpu-ms",
					maximum: 10,
				},
			],
		});
		expect(evaluateBudgetPolicy(policy, context()).ok).toBe(true);
		const gpu = context({ workload: "batch.gpu" });
		expect(evaluateBudgetPolicy(policy, gpu).code).toBe(
			"budget.policy.unsupported-constraint",
		);
		expect(
			evaluateBudgetPolicy(policy, {
				...gpu,
				measurements: [{ key: "acme.gpu.time", unit: "USD.micros", value: 1 }],
			}).ok,
		).toBe(false);
		expect(
			evaluateBudgetPolicy(policy, {
				...gpu,
				measurements: [{ key: "acme.gpu.time", unit: "gpu-ms", value: 10 }],
			}).ok,
		).toBe(true);
	});
	it("requires the full work duration to fit inside an explicit funding window", () => {
		const fixed = parseBudgetPolicy({
			...authored(),
			periodKind: "fixed-window",
			periodStartsAtMs: 1000,
			periodEndsAtMs: 2000,
		});
		const measurements = [{ key: "work.duration", unit: "ms", value: 1000 }];
		expect(evaluateBudgetPolicy(fixed, context()).ok).toBe(false);
		expect(evaluateBudgetPolicy(fixed, context({ measurements })).ok).toBe(
			true,
		);
		expect(
			evaluateBudgetPolicy(fixed, context({ measurements, nowMs: 1001 })).code,
		).toBe("budget.policy.period");
		expect(
			evaluateBudgetPolicy(fixed, context({ measurements, nowMs: 999 })).ok,
		).toBe(false);
		expect(
			evaluateBudgetPolicy(fixed, context({ measurements, nowMs: 2000 })).ok,
		).toBe(false);
	});
});

describe("shared budget threshold identity", () => {
	const identity = {
		tenantId: "team",
		budgetId: "engineering",
		periodId: "period-1",
		policyRevision: "r1",
	};
	it("binds all identity fields and permits reset zero without consuming crossing one", () => {
		expect(budgetScopeIdentityKey(identity)).toBe(
			'["team","engineering","period-1","r1"]',
		);
		expect(budgetThresholdSignalKey(identity, 1, "reset", 0)).toContain(
			":1:reset:0",
		);
		expect(budgetThresholdSignalKey(identity, 1, "crossed", 1)).toContain(
			":1:crossed:1",
		);
		expect(() => budgetThresholdSignalKey(identity, 1, "reset", 1)).toThrow();
		expect(() =>
			budgetThresholdSignalKey(identity, 1, "recovered", 0),
		).toThrow();
	});
	it("does not coerce absent or numeric JS identifiers into strings", () => {
		// @ts-expect-error JS callers may omit scope fields; the runtime guard must refuse.
		expect(() =>
			budgetScopeIdentityKey({ ...identity, tenantId: undefined }),
		).toThrow();
		// @ts-expect-error A numeric provider/customer ID is not a canonical budget identity.
		expect(() =>
			budgetScopeIdentityKey({ ...identity, budgetId: 123 }),
		).toThrow();
	});
});
