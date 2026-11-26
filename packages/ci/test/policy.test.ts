import { readFileSync } from "node:fs";
import { create, type JsonObject, toJsonString } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { AccountSchema } from "../src/_generated/ci_pb.js";
import { DesiredCiPolicySchema } from "../src/_generated/policy_pb.js";
import {
	ciBudgetIdentity,
	ciBudgetPolicyJson,
	ciQueueBudgetMs,
	defineCiPolicy,
	effectiveCiAccount,
	parseCiPolicy,
} from "../src/policy.js";

const valid = JSON.parse(
	readFileSync(
		new URL(
			"../data-models/fixtures/valid/desired-policy.json",
			import.meta.url,
		),
		"utf8",
	),
);
function input() {
	return structuredClone(valid);
}
function common(overrides: JsonObject = {}): JsonObject {
	return {
		schemaVersion: "hobo.budget-policy/v1",
		tenantId: "acme",
		budgetId: "ci",
		periodId: "manual-1",
		revision: "r1",
		workloads: ["ci"],
		currency: "USD",
		limitMicros: 300,
		objective: "min-cost",
		enforcement: "conservative",
		periodKind: "manual",
		constraints: [],
		...overrides,
	};
}

describe("authored CI policy", () => {
	it.each([
		"dagger",
		"cloudflare",
	])("accepts %s financial intent without asserting an official Actions runner capability", (kind) => {
		const authored = input();
		authored.providers = [
			{
				id: "native",
				kind,
				connectionRef: "native-engine",
				runsOn: "native-pipeline",
			},
		];
		authored.budgetPolicy = common();
		expect(defineCiPolicy(authored).providers[0]?.kind).toBe(kind);
	});
	it("applies common intent and both existing ceilings without widening runtime authority", () => {
		const authored = input();
		authored.budgetPolicy = common();
		const policy = defineCiPolicy(authored);
		const account = create(AccountSchema, { id: "acme", budgetMicros: 1000 });
		expect(effectiveCiAccount(account, policy)).toMatchObject({
			budgetMicros: 300,
			routingStrategy: "min-cost",
		});
		account.budgetMicros = 100;
		expect(effectiveCiAccount(account, policy).budgetMicros).toBe(100);
		expect(
			ciBudgetIdentity(
				effectiveCiAccount(account, policy),
				"2026-10-30T00:00:00Z",
			),
		).toMatchObject({
			budgetTenantId: "acme",
			budgetId: "ci",
			budgetPeriodId: "manual-1",
			budgetPolicyRevision: "r1",
			budgetPolicyDigest: ciBudgetPolicyJson(policy.budgetPolicy),
		});
	});
	it("requires common tenant, workload and objective agreement and rejects unknown controls", () => {
		for (const invalid of [
			common({ tenantId: "foreign" }),
			common({ workloads: ["hosting"] }),
			common({ objective: "maximize-credits" }),
			common({ advisoryOnly: true }),
		]) {
			const authored = input();
			authored.budgetPolicy = invalid;
			expect(() => defineCiPolicy(authored)).toThrow();
		}
		const authored = input();
		authored.routing.strategy = "maximize-credits";
		authored.budgetPolicy = common({ objective: "maximize-credits" });
		expect(
			effectiveCiAccount(
				create(AccountSchema, { id: "acme", budgetMicros: 1000 }),
				defineCiPolicy(authored),
			).routingStrategy,
		).toBe("maximize-credits");
	});
	it("deeply freezes shared policy and extracts only declared queue-duration controls", () => {
		const authored = input();
		authored.budgetPolicy = common({
			constraints: [
				{ key: "ci.queue.duration", workload: "ci", unit: "ms", maximum: 5000 },
			],
		});
		const policy = defineCiPolicy(authored);
		expect(Object.isFrozen(policy.budgetPolicy)).toBe(true);
		expect(Object.isFrozen(policy.budgetPolicy?.constraints)).toBe(true);
		expect(ciQueueBudgetMs(policy)).toBe(5000);
	});
	it("rejects duplicate top-level and embedded controls before protobuf normalization", () => {
		const authored = input();
		authored.budgetPolicy = common();
		const json = JSON.stringify(authored);
		expect(() =>
			parseCiPolicy(
				json.replace(
					'"tenantId":"acme"',
					'"tenantId":"foreign","tenantId":"acme"',
				),
			),
		).toThrow(/duplicate/);
		expect(() =>
			parseCiPolicy(
				json.replace('"limitMicros":300', '"limitMicros":1,"limitMicros":300'),
			),
		).toThrow(/duplicate/);
	});
	it("round-trips generated policy JSON while freezing all nested intent", () => {
		const authored = input();
		const policy = defineCiPolicy(authored);
		authored.providers[0].runsOn = "untrusted";
		expect(policy.providers[0]?.runsOn).toBe("ubuntu-24.04");
		expect(Object.isFrozen(policy.providers[0])).toBe(true);
		expect(Object.isFrozen(policy.thresholds[0]?.allow)).toBe(true);
		expect(parseCiPolicy(toJsonString(DesiredCiPolicySchema, policy))).toEqual(
			policy,
		);
	});
	it("rejects runtime-owned financial fields at the generated boundary", () => {
		const policy = input();
		policy.providers[0].freeMinutes = 100;
		expect(() => defineCiPolicy(policy)).toThrow();
		const account = input();
		account.spentMicros = 0;
		expect(() => defineCiPolicy(account)).toThrow();
	});
	it.each([
		"foreign",
		"duplicate",
		"threshold",
		"pool",
		"rollover",
		"credentials",
		"self-label",
		"unsafe-budget",
	])("rejects invalid %s policy", (kind) => {
		const policy = input();
		if (kind === "foreign") policy.thresholds[0].allow = ["unknown"];
		if (kind === "duplicate")
			policy.providers.push(structuredClone(policy.providers[0]));
		if (kind === "threshold")
			policy.thresholds.push(structuredClone(policy.thresholds[0]));
		if (kind === "pool") policy.pool.os = "windows";
		if (kind === "rollover") policy.budget.period = "calendar-month";
		if (kind === "credentials")
			policy.providers[0].connectionRef = "token value with spaces";
		if (kind === "self-label") policy.providers[0].runsOn = "HoBo";
		if (kind === "unsafe-budget") policy.budget.limitMicros = 9007199254740992;
		expect(() => defineCiPolicy(policy)).toThrow();
	});
	it("accepts explicit empty threshold profiles as a pause", () => {
		const policy = defineCiPolicy(input());
		expect(policy.thresholds[0]?.allow).toEqual([]);
	});
	it("accepts a Vercel Sandbox provider in the authored inventory", () => {
		const policy = input();
		policy.providers.push({
			id: "isolated",
			kind: "vercel",
			connectionRef: "vercel-team",
			runsOn: "sandbox",
			enabled: true,
		});
		expect(defineCiPolicy(policy).providers[1]?.kind).toBe("vercel");
	});
});
