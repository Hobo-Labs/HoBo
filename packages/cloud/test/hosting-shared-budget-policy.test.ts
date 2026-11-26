import { fromBinary, fromJsonString, toBinary } from "@bufbuild/protobuf";
import { parseManifest } from "@hobo/bindles";
import { canonicalBudgetPolicyJson, parseBudgetPolicy } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { HostingPlanningInputSchema } from "../src/_generated/hosting_planning_pb.js";
import type { JsonObject } from "../src/json.js";
import {
	createHostingPlanningPass,
	type HostingPlanningInput,
	type HostingPriceQuote,
	manifestHostingPolicy,
} from "../src/planner/hosting-budget.js";
import { plan } from "../src/planner/plan.js";
import type { ResourceDefinition } from "../src/registry/catalog.js";

const NOW = 1000;
const END = 5000;
function policy(changes: JsonObject = {}): JsonObject {
	return {
		schemaVersion: "hobo.budget-policy/v1",
		tenantId: "tenant",
		budgetId: "budget",
		periodId: "period",
		revision: "r1",
		workloads: ["hosting", "ci"],
		currency: "USD",
		limitMicros: 1000,
		objective: "min-cost",
		enforcement: "strict",
		periodKind: "fixed-window",
		periodStartsAtMs: 0,
		periodEndsAtMs: 10_000,
		constraints: [],
		...changes,
	};
}
function quote(
	name = "app",
	changes: Partial<HostingPriceQuote> = {},
): HostingPriceQuote {
	return {
		id: `quote:${name}`,
		resourceName: name,
		definitionId: "a",
		providerId: "a",
		providerAccountId: "account:a",
		currency: "USD",
		rateMicros: 60,
		billingUnit: "request",
		billingPeriodMs: 0,
		source: "trusted:quote-service",
		observedAtMs: NOW,
		validUntilMs: 10_000,
		liabilityEndsAtMs: END,
		entitlementId: "",
		minimumQuantity: 0,
		roundUpQuantity: false,
		fixedCostMicros: 0,
		transitionCostMicros: 0,
		...changes,
	};
}
function evidence(
	budgetPolicy = policy(),
	names = ["app"],
): HostingPlanningInput {
	return {
		nowMs: NOW,
		horizonEndMs: END,
		maxObservationAgeMs: 100,
		budget: {
			budgetId: "budget",
			tenantId: "tenant",
			scopeId: "camp:prod",
			periodId: "period",
			policyRevision: "r1",
			ledgerSeq: 1,
			currency: "USD",
			periodStartMs: 0,
			periodEndMs: 10_000,
			capMicros: 1000,
			settledMicros: 0,
			committedMicros: 0,
			unresolvedMicros: 0,
			recoveryReserveMicros: 0,
			observedAtMs: NOW,
			validUntilMs: 10_000,
			providerAccountId: "",
		},
		budgetPolicy,
		quotes: names.map((name) => quote(name)),
		usages: names.map((resourceName) => ({
			resourceName,
			unit: "request",
			expectedQuantity: 1,
			boundedQuantity: 1,
		})),
		entitlements: [],
		providerBudgets: [],
	};
}
const definition: ResourceDefinition = {
	id: "a",
	providerId: "a",
	port: "compute",
	features: ["http"],
	regions: ["us"],
	specificity: 1,
	priority: 0,
	cost: { sku: "test", marginalPrice: "0.00006", unit: "request" },
	satisfies: () => ({ kind: "full" }),
};
const registry = {
	catalogHash: "sha256:test",
	definitions: () => [definition],
	providers: () => ["a"],
};
function manifest(
	budgetPolicy: JsonObject,
	names = ["app"],
	extraPolicy: JsonObject = {},
) {
	return parseManifest({
		schema: "hobo.manifest/v1",
		componentHost: { kind: "wasm", version: "1" },
		policy: { ...extraPolicy, budgetPolicy },
		resources: Object.fromEntries(
			names.map((name) => [
				name,
				{
					type: "component.v1",
					runtime: "wasm",
					image: "oci://test/app",
					exports: ["wasi:http/incoming-handler"],
				},
			]),
		),
	});
}
function run(input = evidence(), authored = input.budgetPolicy ?? policy()) {
	return plan(
		manifest(
			authored,
			input.usages.map((usage) => usage.resourceName),
		),
		{ deploymentId: "test", hostingBudget: input },
		registry,
	);
}

describe("shared hosting BudgetPolicy", () => {
	it("plans strict policies with conservative estimates and pins the complete policy through protobuf", () => {
		const input = evidence();
		const first = run(input);
		expect(first.ok).toBe(true);
		if (!first.ok || !first.hostingCommitment)
			throw new Error("expected financial plan");
		const wire = fromJsonString(
			HostingPlanningInputSchema,
			JSON.stringify(first.hostingCommitment.evidence),
		);
		const restored = fromBinary(
			HostingPlanningInputSchema,
			toBinary(HostingPlanningInputSchema, wire),
		);
		if (!restored.budget || !restored.budgetPolicy)
			throw new Error("lost pinned evidence");
		expect(
			canonicalBudgetPolicyJson(parseBudgetPolicy(restored.budgetPolicy)),
		).toBe(
			canonicalBudgetPolicyJson(parseBudgetPolicy(input.budgetPolicy ?? null)),
		);
		const replay = createHostingPlanningPass({
			...restored,
			budget: restored.budget,
		});
		replay.commit("app", definition);
		expect(replay.commitment().commitmentHash).toBe(
			first.hostingCommitment.commitmentHash,
		);
	});

	it("requires the authoritative lane and exact authored policy pin", () => {
		expect(
			plan(manifest(policy()), { deploymentId: "missing" }, registry).ok,
		).toBe(false);
		const input = evidence();
		const { budgetPolicy: _policy, ...unpinned } = input;
		expect(run(unpinned).ok).toBe(false);
		expect(
			run(
				input,
				policy({
					constraints: [
						{
							key: "work.cost",
							workload: "hosting",
							unit: "USD.micros",
							maximum: 59,
						},
					],
				}),
			).ok,
		).toBe(false);
	});

	it.each([
		"tenantId",
		"budgetId",
		"periodId",
		"revision",
	])("rejects a foreign %s even when authored and pinned policies agree", (field) => {
		const result = run(evidence(policy({ [field]: "other" })));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("identity differ");
	});

	it("uses the policy objective by default and refuses a conflicting caller objective", () => {
		const input = evidence(policy({ objective: "maximize-credits" }));
		const result = run(input);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.plan.objective).toBe("maximize-credits");
		expect(
			plan(
				manifest(input.budgetPolicy ?? policy()),
				{
					deploymentId: "conflict",
					objective: "min-cost",
					hostingBudget: input,
				},
				registry,
			).ok,
		).toBe(false);
	});
	it("also honors the trusted policy objective for a programmatic manifest without authored common policy", () => {
		const input = evidence(policy({ objective: "maximize-credits" }));
		const { policy: _authored, ...raw } = manifest(
			input.budgetPolicy ?? policy(),
		).value;
		const result = plan(
			parseManifest(raw),
			{ deploymentId: "programmatic", hostingBudget: input },
			registry,
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.plan.objective).toBe("maximize-credits");
	});

	it("bounds the entire liability window, including commitments after the requested horizon", () => {
		const input = evidence(policy({ periodEndsAtMs: 6000 }));
		expect(run({ ...input, horizonEndMs: 7000 }).ok).toBe(false);
		expect(
			run({ ...input, quotes: [quote("app", { liabilityEndsAtMs: 7000 })] }).ok,
		).toBe(false);
		const duration = evidence(
			policy({
				constraints: [
					{
						key: "work.duration",
						workload: "hosting",
						unit: "ms",
						maximum: 4000,
					},
				],
			}),
		);
		expect(
			run({ ...duration, quotes: [quote("app", { liabilityEndsAtMs: 6000 })] })
				.ok,
		).toBe(false);
	});

	it("applies the lower legacy/common ceiling and never treats a hard zero as missing", () => {
		const shared = policy({ limitMicros: 100 });
		expect(
			manifestHostingPolicy(
				manifest(shared, ["app"], { budget: { hardLimitUsd: 0.00005 } }),
			).hardLimitMicros,
		).toBe(50);
		const zero = evidence(policy({ limitMicros: 0 }));
		const fundedZero = { ...zero, budget: { ...zero.budget, capMicros: 0 } };
		expect(run(fundedZero).ok).toBe(false);
		expect(
			run({ ...fundedZero, quotes: [quote("app", { rateMicros: 0 })] }).ok,
		).toBe(true);
	});

	it("counts settled, committed, unresolved and recovery exposure against the shared cap", () => {
		const input = evidence(policy({ limitMicros: 100 }));
		const result = run({
			...input,
			budget: {
				...input.budget,
				capMicros: 100,
				settledMicros: 10,
				committedMicros: 10,
				unresolvedMicros: 10,
				recoveryReserveMicros: 20,
			},
		});
		expect(result.ok).toBe(false);
	});
	it("does not relabel another authority currency as USD in direct commitment replay", () => {
		const input = evidence();
		expect(() =>
			createHostingPlanningPass({
				...input,
				budget: { ...input.budget, currency: "EUR" },
			}),
		).toThrow("currency differs");
	});

	it("enforces whole-plan work cost rather than granting the same limit per resource", () => {
		const input = evidence(
			policy({
				constraints: [
					{ key: "work.cost", workload: "*", unit: "USD.micros", maximum: 100 },
				],
			}),
			["app", "worker"],
		);
		expect(run(input).ok).toBe(false);
	});

	it("checks provider cost against the actual source billing account", () => {
		const input = evidence(
			policy({
				constraints: [
					{
						key: "provider.cost",
						target: "source",
						workload: "hosting",
						unit: "USD.micros",
						maximum: 30,
					},
				],
			}),
		);
		const source = { ...input.budget, providerAccountId: "source" };
		expect(
			run({
				...input,
				providerBudgets: [
					source,
					{ ...source, providerAccountId: "account:a" },
				],
				quotes: [
					quote("app", {
						components: [
							{
								id: "egress",
								providerAccountId: "source",
								costClass: "egress",
								expectedMicros: 40,
								boundedMicros: 40,
								entitlementId: "",
							},
						],
					}),
				],
			}).ok,
		).toBe(false);
	});

	it.each([
		{ key: "work.concurrent", workload: "hosting", unit: "count", maximum: 2 },
		{ key: "unknown.control", workload: "*", unit: "count", maximum: 2 },
		{
			key: "work.duration",
			workload: "hosting",
			unit: "seconds",
			maximum: 5000,
		},
		{
			key: "provider.cost",
			workload: "hosting",
			unit: "USD.micros",
			maximum: 100,
			target: "unknown-account",
		},
	])("refuses unavailable or incompatible constraint $key", (constraint) => {
		const result = run(evidence(policy({ constraints: [constraint] })));
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.reason).toContain("required metric is unavailable");
	});

	it("ignores a CI-only metric during hosting while rejecting CI-only policy scope", () => {
		expect(
			run(
				evidence(
					policy({
						constraints: [
							{
								key: "work.concurrent",
								workload: "ci",
								unit: "count",
								maximum: 2,
							},
						],
					}),
				),
			).ok,
		).toBe(true);
		expect(run(evidence(policy({ workloads: ["ci"] }))).ok).toBe(false);
	});

	it("hashes policy changes even when the deployment geometry and selected costs stay identical", () => {
		const first = run(evidence());
		const second = run(evidence(policy({ enforcement: "conservative" })));
		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(first.planHash).toBe(second.planHash);
		expect(first.hostingCommitment?.commitmentHash).not.toBe(
			second.hostingCommitment?.commitmentHash,
		);
	});

	it("preserves legacy manifests and financial evidence without common policy", () => {
		const input = evidence();
		const { budgetPolicy: _policy, ...legacy } = input;
		expect(
			createHostingPlanningPass(legacy).commit("app", definition)
				.reservedMicros,
		).toBe(60);
	});
});
