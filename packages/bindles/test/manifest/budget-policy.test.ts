import { canonicalBudgetPolicyJson, parseBudgetPolicy } from "@hobo/core";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../src/json.js";
import {
	canonicalManifestHash,
	ManifestParseError,
	parseManifest,
	serializeManifest,
} from "../../src/manifest/index.js";

function policy(changes: JsonObject = {}): JsonObject {
	return {
		schemaVersion: "hobo.budget-policy/v1",
		tenantId: "tenant",
		budgetId: "shared",
		periodId: "manual:1",
		revision: "r1",
		workloads: ["hosting", "ci"],
		currency: "USD",
		limitMicros: 100,
		objective: "min-cost",
		enforcement: "strict",
		periodKind: "manual",
		constraints: [
			{ key: "work.cost", workload: "*", unit: "USD.micros", maximum: 100 },
		],
		...changes,
	};
}
function manifest(budgetPolicy: JsonObject) {
	return {
		schema: "hobo.manifest/v1",
		componentHost: { kind: "wasm", version: "1" },
		resources: {
			app: { type: "component.v1", runtime: "wasm", image: "oci://test/app" },
		},
		policy: {
			budgetPolicy,
			boundaryContracts: ["effects:app@v1"],
			resilienceProfileRef: "resilience:prod@v1",
		},
	};
}

describe("canonical manifest shared BudgetPolicy", () => {
	it("preserves the complete common policy and effect/resilience references through canonical serialization", () => {
		const raw = manifest(policy());
		const first = parseManifest(raw);
		const second = parseManifest(JSON.parse(serializeManifest(first)));
		expect(second.value.policy).toEqual(raw.policy);
		expect(
			canonicalBudgetPolicyJson(
				parseBudgetPolicy(second.value.policy?.budgetPolicy ?? null),
			),
		).toBe(
			canonicalBudgetPolicyJson(parseBudgetPolicy(raw.policy.budgetPolicy)),
		);
		expect(canonicalManifestHash(second)).toBe(canonicalManifestHash(first));
		expect(
			canonicalManifestHash(
				parseManifest(manifest(policy({ enforcement: "conservative" }))),
			),
		).not.toBe(canonicalManifestHash(first));
	});

	it.each([
		{ fallback: "allow" },
		{ limitMicros: -1 },
		{ currency: "EUR" },
		{ objective: "lowest-carbon" },
		{ enforcement: "best-effort" },
		{
			constraints: [
				{
					key: "work.cost",
					workload: "hosting",
					unit: "USD.micros",
					maximum: 100,
					ignoreMissing: true,
				},
			],
		},
		{ periodKind: "monthly" },
	])("rejects unsupported or malformed budget controls %#", (changes) => {
		expect(() => parseManifest(manifest(policy(changes)))).toThrow(
			ManifestParseError,
		);
	});
	it.each([
		null,
		[],
		"skip-budget",
	])("rejects a non-object shared policy %j", (budgetPolicy) => {
		expect(() =>
			parseManifest({ ...manifest(policy()), policy: { budgetPolicy } }),
		).toThrow(ManifestParseError);
	});

	it("rejects shared control in a per-resource location rather than assigning ambiguous scope", () => {
		const raw = manifest(policy());
		expect(() =>
			parseManifest({
				...raw,
				resources: {
					app: { ...raw.resources.app, policy: { budgetPolicy: policy() } },
				},
			}),
		).toThrow("manifest.policy.budgetPolicy");
	});

	it("preserves the existing legacy financial policy", () => {
		const raw = manifest(policy());
		const legacy = { budget: { hardLimitUsd: 1, period: "monthly" } };
		expect(parseManifest({ ...raw, policy: legacy }).value.policy).toEqual(
			legacy,
		);
	});
});
