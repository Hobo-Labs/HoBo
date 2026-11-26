import { parseManifest } from "@hobo/bindles";
import { describe, expect, it } from "vitest";
import {
	createHostingPlanningPass,
	type HostingPlanningInput,
	type HostingPriceQuote,
} from "../src/planner/hosting-budget.js";
import { matchResource } from "../src/planner/matching.js";
import { plan } from "../src/planner/plan.js";
import type { ResourceDefinition } from "../src/registry/catalog.js";

const NOW = 1000;
const HOUR = 3_600_000;
const END = NOW + HOUR;
const PERIOD_END = 31 * 24 * HOUR;
function evidence() {
	return {
		nowMs: NOW,
		horizonEndMs: END,
		maxObservationAgeMs: 1000,
		budget: {
			budgetId: "hosting",
			tenantId: "tenant",
			scopeId: "camp:prod",
			periodId: "period:one",
			policyRevision: "r1",
			ledgerSeq: 1,
			currency: "USD",
			periodStartMs: 0,
			periodEndMs: PERIOD_END,
			capMicros: 100_000,
			settledMicros: 0,
			committedMicros: 0,
			unresolvedMicros: 0,
			recoveryReserveMicros: 0,
			observedAtMs: NOW,
			validUntilMs: PERIOD_END,
			providerAccountId: "",
		},
		quotes: [],
		usages: [
			{
				resourceName: "app",
				unit: "time-ms",
				expectedQuantity: HOUR,
				boundedQuantity: HOUR,
			},
		],
		entitlements: [],
		providerBudgets: [],
	} satisfies HostingPlanningInput;
}
function quote(
	id: string,
	changes: Partial<HostingPriceQuote> = {},
): HostingPriceQuote {
	return {
		id: `quote:${id}`,
		resourceName: "app",
		definitionId: id,
		providerId: id,
		providerAccountId: `account:${id}`,
		currency: "USD",
		rateMicros: 100,
		billingUnit: "hour",
		billingPeriodMs: 0,
		source: "https://example.test/quoted-terms",
		observedAtMs: NOW,
		validUntilMs: PERIOD_END,
		liabilityEndsAtMs: END,
		entitlementId: "",
		minimumQuantity: 0,
		roundUpQuantity: false,
		fixedCostMicros: 0,
		transitionCostMicros: 0,
		...changes,
	};
}
function definition(
	id: string,
	price = "1",
	unit = "hour",
): ResourceDefinition {
	return {
		id,
		providerId: id,
		port: "compute",
		features: ["http"],
		regions: ["us"],
		specificity: 1,
		priority: 0,
		cost: { sku: id, marginalPrice: price, unit },
		satisfies: () => ({ kind: "full" }),
	};
}
function registry(definitions: ResourceDefinition[]) {
	return {
		catalogHash: "sha256:test",
		definitions: () => definitions,
		providers: () => definitions.map((d) => d.providerId),
	};
}
function manifest(names = ["app"]) {
	return parseManifest({
		schema: "hobo.manifest/v1",
		componentHost: { kind: "wasm", version: "1" },
		resources: Object.fromEntries(
			names.map((name) => [
				name,
				{
					type: "component.v1",
					image: "oci://example/app",
					runtime: "wasm",
					exports: ["wasi:http/incoming-handler"],
				},
			]),
		),
	});
}
function run(
	input: HostingPlanningInput,
	definitions: ResourceDefinition[] = [definition("a"), definition("b")],
	names = ["app"],
) {
	return plan(
		manifest(names),
		{
			deploymentId: "deploy",
			objective: "maximize-credits",
			hostingBudget: input,
		},
		registry(definitions),
	);
}

describe("budget-aware cloud hosting planning", () => {
	it("rejects unsupported objectives and refuses credit routing without ledger evidence", () => {
		for (const objective of ["maximize-credits", "carbon", "latency", "typo"]) {
			const result = plan(
				manifest(),
				{ deploymentId: "x", objective },
				registry([definition("a")]),
			);
			expect(result.ok).toBe(false);
			if (!result.ok)
				expect(result.remediations[0]?.code).toBe(
					"placement.unsupported-objective",
				);
		}
	});
	it("refuses raw hourly/monthly ranking without a common horizon", () => {
		const result = plan(
			manifest(),
			{ deploymentId: "x" },
			registry([
				definition("a", "0.10", "hour"),
				definition("b", "1", "month"),
			]),
		);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.remediations[0]?.code).toBe("cost.incomparable-units");
	});
	it("normalizes $0.10/hour versus $1/month over the exact quoted month", () => {
		const input = evidence(),
			month = 730 * HOUR;
		input.horizonEndMs = NOW + month;
		input.budget.capMicros = 100_000_000;
		input.usages = [
			{
				resourceName: "app",
				unit: "time-ms",
				expectedQuantity: month,
				boundedQuantity: month,
			},
		];
		input.quotes = [
			quote("a", { rateMicros: 100_000, liabilityEndsAtMs: NOW + month }),
			quote("b", {
				billingUnit: "month",
				billingPeriodMs: month,
				rateMicros: 1_000_000,
				liabilityEndsAtMs: NOW + month,
			}),
		];
		const result = run(input);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.plan.resources[0]?.provider).toBe("b");
			expect(result.hostingCommitment?.reservedMicros).toBe(1_000_000);
		}
	});
	it("minimizes the whole paid bill after partial free allowance", () => {
		const input = evidence();
		input.usages = [
			{
				resourceName: "app",
				unit: "request",
				expectedQuantity: 10,
				boundedQuantity: 10,
			},
		];
		input.entitlements = [
			{
				id: "free-a",
				providerAccountId: "account:a",
				currency: "USD",
				unit: "request",
				remainingQuantity: 1,
				validUntilMs: PERIOD_END,
				definitionIds: ["a"],
				periodId: input.budget.periodId,
			},
		];
		input.quotes = [
			quote("a", {
				billingUnit: "request",
				rateMicros: 1000,
				entitlementId: "free-a",
			}),
			quote("b", { billingUnit: "request", rateMicros: 100 }),
		];
		const result = run(input);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.plan.resources[0]?.provider).toBe("b");
			expect(result.hostingCommitment?.expectedMicros).toBe(1000);
		}
	});
	it("admits against bounded exposure including transition, unresolved and recovery costs", () => {
		const input = evidence();
		input.budget.capMicros = 10_000;
		input.budget.settledMicros = 7000;
		input.budget.committedMicros = 1000;
		input.budget.unresolvedMicros = 1000;
		input.budget.recoveryReserveMicros = 500;
		input.providerBudgets = [
			{ ...input.budget, providerAccountId: "account:a" },
		];
		const transition = (cost: number) =>
			quote("a", {
				rateMicros: 300,
				transitionCostMicros: cost,
				components: [
					{
						id: "egress",
						providerAccountId: "account:a",
						costClass: "egress",
						expectedMicros: cost,
						boundedMicros: cost,
						entitlementId: "",
					},
				],
			});
		input.quotes = [transition(201)];
		expect(run(input, [definition("a")]).ok).toBe(false);
		input.quotes = [transition(200)];
		expect(run(input, [definition("a")]).ok).toBe(true);
	});
	it("does not admit a cheap expectation whose usage bound exceeds the cap", () => {
		const input = evidence();
		input.budget.capMicros = 500;
		input.usages = [
			{
				resourceName: "app",
				unit: "request",
				expectedQuantity: 1,
				boundedQuantity: 6,
			},
		];
		input.quotes = [quote("a", { billingUnit: "request", rateMicros: 100 })];
		expect(run(input, [definition("a")]).ok).toBe(false);
	});
	it.each([
		{ observedAtMs: NOW + 1 },
		{ validUntilMs: END - 1 },
		{ currency: "EUR" },
		{ providerId: "foreign" },
		{ liabilityEndsAtMs: PERIOD_END + 1 },
		{ rateMicros: -1 },
		{ rateMicros: Infinity },
		{ source: "" },
	])("refuses invalid or stale financial evidence %j", (changes) => {
		const input = evidence();
		input.quotes = [quote("a", changes)];
		expect(run(input, [definition("a")]).ok).toBe(false);
	});
	it("verified zero remains usable at a zero cap; missing price evidence does not", () => {
		const input = evidence();
		input.budget.capMicros = 0;
		input.quotes = [quote("a", { rateMicros: 0 })];
		expect(run(input, [definition("a", "0")]).ok).toBe(true);
		input.quotes = [];
		expect(run(input, [definition("a", "0")]).ok).toBe(false);
	});
	it("shares one entitlement and parent allowance across all resources", () => {
		const input = evidence();
		input.budget.capMicros = 1500;
		input.usages = ["app", "worker"].map((resourceName) => ({
			resourceName,
			unit: "request",
			expectedQuantity: 10,
			boundedQuantity: 10,
		}));
		input.entitlements = [
			{
				id: "shared",
				providerAccountId: "account:a",
				currency: "USD",
				unit: "request",
				remainingQuantity: 10,
				validUntilMs: PERIOD_END,
				definitionIds: ["a"],
				periodId: input.budget.periodId,
			},
		];
		input.quotes = ["app", "worker"].map((resourceName) =>
			quote("a", {
				id: `quote:${resourceName}`,
				resourceName,
				billingUnit: "request",
				rateMicros: 100,
				entitlementId: "shared",
			}),
		);
		const result = run(input, [definition("a")], ["app", "worker"]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.hostingCommitment?.reservedMicros).toBe(1000);
			expect(
				result.hostingCommitment?.allocations.reduce(
					(sum, a) => sum + a.reservedEntitlementQuantity,
					0,
				),
			).toBe(10);
		}
		input.budget.capMicros = 500;
		expect(run(input, [definition("a")], ["app", "worker"]).ok).toBe(false);
	});
	it("enforces provider ceilings and rejects foreign or expired shared credits", () => {
		const input = evidence();
		input.providerBudgets = [
			{
				...input.budget,
				budgetId: "account-cap",
				providerAccountId: "account:a",
				capMicros: 99,
			},
		];
		input.quotes = [quote("a")];
		expect(run(input, [definition("a")]).ok).toBe(false);
		input.providerBudgets = [];
		input.entitlements = [
			{
				id: "credit",
				providerAccountId: "account:foreign",
				currency: "USD",
				unit: "micros",
				remainingQuantity: 100,
				validUntilMs: PERIOD_END,
				definitionIds: [],
				periodId: input.budget.periodId,
			},
		];
		input.quotes = [quote("a", { entitlementId: "credit" })];
		expect(run(input, [definition("a")]).ok).toBe(false);
	});
	it("charges source egress to its own capped account even when destination usage is free", () => {
		const input = evidence();
		input.providerBudgets = [
			{ ...input.budget, providerAccountId: "source", capMicros: 0 },
			{ ...input.budget, providerAccountId: "account:a" },
		];
		input.entitlements = [
			{
				id: "destination-credit",
				providerAccountId: "account:a",
				currency: "USD",
				unit: "micros",
				remainingQuantity: 1000,
				validUntilMs: END,
				definitionIds: ["a"],
				periodId: input.budget.periodId,
			},
		];
		input.quotes = [
			quote("a", {
				entitlementId: "destination-credit",
				components: [
					{
						id: "source-egress",
						providerAccountId: "source",
						costClass: "egress",
						expectedMicros: 50,
						boundedMicros: 60,
						entitlementId: "",
					},
				],
			}),
		];
		expect(run(input, [definition("a")]).ok).toBe(false);
		input.providerBudgets[0] = { ...input.providerBudgets[0], capMicros: 60 };
		const pass = createHostingPlanningPass(input);
		const allocation = pass.commit("app", definition("a"));
		expect(allocation.providerCharges).toEqual([
			{ providerAccountId: "account:a", expectedMicros: 0, reservedMicros: 0 },
			{ providerAccountId: "source", expectedMicros: 50, reservedMicros: 60 },
		]);
		expect(allocation.reservedMicros).toBe(60);
		input.quotes = [
			quote("a", {
				entitlementId: "destination-credit",
				components: [
					{
						id: "source-egress",
						providerAccountId: "source",
						costClass: "egress",
						expectedMicros: 50,
						boundedMicros: 60,
						entitlementId: "destination-credit",
					},
				],
			}),
		];
		expect(run(input, [definition("a")]).ok).toBe(false);
	});
	it("limits promotional credits to eligible usage and explicitly named component classes", () => {
		const input = evidence();
		input.providerBudgets = [
			{ ...input.budget, providerAccountId: "account:a" },
		];
		input.entitlements = [
			{
				id: "promo",
				providerAccountId: "account:a",
				currency: "USD",
				unit: "micros",
				remainingQuantity: 1000,
				validUntilMs: END,
				definitionIds: ["a"],
				periodId: input.budget.periodId,
			},
		];
		input.quotes = [
			quote("a", {
				entitlementId: "promo",
				fixedCostMicros: 30,
				components: [
					{
						id: "egress",
						providerAccountId: "account:a",
						costClass: "egress",
						expectedMicros: 50,
						boundedMicros: 60,
						entitlementId: "",
					},
				],
			}),
		];
		expect(
			createHostingPlanningPass(input).commit("app", definition("a")),
		).toMatchObject({ expectedMicros: 80, reservedMicros: 90 });
		input.quotes = [
			quote("a", {
				entitlementId: "promo",
				components: [
					{
						id: "egress",
						providerAccountId: "account:a",
						costClass: "egress",
						expectedMicros: 50,
						boundedMicros: 60,
						entitlementId: "promo",
					},
				],
			}),
		];
		expect(run(input, [definition("a")]).ok).toBe(false);
		input.entitlements = [
			{
				...input.entitlements[0],
				remainingQuantity: 150,
				costClasses: ["usage", "egress"],
			},
		];
		const pass = createHostingPlanningPass(input);
		// Repeated scoring never spends the shared allowance.
		expect(pass.evaluate("app", definition("a"))).toEqual(
			pass.evaluate("app", definition("a")),
		);
		const allocation = pass.commit("app", definition("a"));
		expect(allocation).toMatchObject({ expectedMicros: 0, reservedMicros: 10 });
		expect(allocation.entitlementClaims).toEqual([
			{
				entitlementId: "promo",
				unit: "micros",
				quantity: 100,
				costClass: "usage",
			},
			{
				entitlementId: "promo",
				unit: "micros",
				quantity: 50,
				costClass: "egress",
			},
		]);
	});
	it("requires complete owned transition bounds and period-scoped credits", () => {
		const input = evidence();
		input.quotes = [quote("a", { transitionCostMicros: 1 })];
		expect(run(input, [definition("a")]).ok).toBe(false);
		input.providerBudgets = [
			{ ...input.budget, providerAccountId: "account:a" },
		];
		input.quotes = [
			quote("a", {
				components: [
					{
						id: "bad-bound",
						providerAccountId: "account:a",
						costClass: "cleanup",
						expectedMicros: 10,
						boundedMicros: 9,
						entitlementId: "",
					},
				],
			}),
		];
		expect(run(input, [definition("a")]).ok).toBe(false);
		input.quotes = [quote("a", { entitlementId: "expired-period" })];
		input.entitlements = [
			{
				id: "expired-period",
				providerAccountId: "account:a",
				currency: "USD",
				unit: "micros",
				remainingQuantity: 1000,
				validUntilMs: END,
				definitionIds: ["a"],
				periodId: "period:previous",
			},
		];
		expect(() => createHostingPlanningPass(input)).toThrow(
			"different financial period",
		);
	});
	it("replays with byte-stable commitments independent of quote input order", () => {
		const input = evidence();
		input.quotes = [quote("a"), quote("b", { rateMicros: 200 })];
		const first = run(input),
			second = run({ ...input, quotes: [...input.quotes].reverse() });
		expect(first).toEqual(second);
	});
	it("withholds a legacy cost-optimal claim when zero was never declared as a price", () => {
		const outcome = matchResource(
			{
				name: "app",
				port: "compute",
				require: [],
				prefer: [],
				negotiation: "require",
				deps: [],
				objective: "min-cost",
			},
			registry([definition("a", "0")]),
		);
		expect(outcome.ok).toBe(true);
		if (outcome.ok)
			expect(outcome.decision.rationale).toContain("cost optimum unclaimed");
	});
	it("rounds fractional usage upward in exact integer micros", () => {
		for (let micros = 1; micros <= 40; micros++) {
			const input = evidence();
			input.usages = [
				{
					resourceName: "app",
					unit: "time-ms",
					expectedQuantity: 1,
					boundedQuantity: 1,
				},
			];
			input.quotes = [quote("a", { rateMicros: micros })];
			const result = createHostingPlanningPass(input).commit(
				"app",
				definition("a"),
			);
			expect(result.reservedMicros).toBe(1);
		}
	});
});
