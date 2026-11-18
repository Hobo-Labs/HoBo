import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clone, create } from "@bufbuild/protobuf";
import {
	createTargetPricingInventory,
	QuoteScenarioSchema,
	quoteTargetPricing,
	targetPricingModel,
	targetPricingUnavailable,
} from "@hobo/pricing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	commitmentState,
	creditState,
	fixedCharge,
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "../../pricing/test/fixtures.js";
import {
	admitIacTarget,
	BudgetEntitlementSchema,
	BudgetLedgerSnapshotSchema,
	BudgetProviderAccountSchema,
	createIacFinancialServices,
	createSqliteBudgetAdmissionAuthority,
	type GateDecision,
	HostingPolicyProofSchema,
	IacTargetLiabilityEvidenceSchema,
} from "../src/index.js";

const NOW = "2026-01-02T00:00:00Z";
const END = "2026-01-31T23:59:59Z";
const PLAN = `sha256:${"a".repeat(64)}`;
const directories: string[] = [];
afterEach(() => {
	for (const path of directories.splice(0))
		rmSync(path, { recursive: true, force: true });
});

function fixture() {
	const scenario = makeScenario({
		charges: [perUnitCharge("runtime", "minute", "0.25")],
		candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
	});
	const inventory = createTargetPricingInventory({
		targetId: "yard-a",
		tenantId: "tenant-a",
		planDigest: PLAN,
		complete: true,
		evidenceRef: "inventory:1",
		resources: [
			{
				resourceId: "resource-a",
				providerId: "sandbox",
				providerAccountRef: "account-a",
				productId: "sandbox",
			},
		],
	});
	const pricing = targetPricingModel({
		modelId: "terms",
		revision: "1",
		planDigest: PLAN,
		scenario,
		bindings: [{ resourceId: "resource-a", candidateIndex: 0 }],
	});
	const result = quoteTargetPricing(inventory, pricing);
	if (!result.ok) throw new Error(result.reason);
	const evidence = create(IacTargetLiabilityEvidenceSchema, {
		evidenceRef: "evidence:provider-bound",
		targetId: "yard-a",
		tenantId: "tenant-a",
		planDigest: PLAN,
		inventoryHash: result.inventoryHash,
		modelHash: result.modelHash,
		quoteHash: result.quote.quoteHash,
		maximumMicros: 1_500_000,
		observedAt: "2026-01-01T00:00:00Z",
		validUntil: END,
		providerAccounts: [
			{ providerAccountId: "account-a", liabilityMicros: 1_500_000 },
		],
	});
	return { inventory, pricing, evidence };
}

function financialPlan(
	inventory: ReturnType<typeof createTargetPricingInventory>,
) {
	return {
		targetId: inventory.targetId,
		tenantId: inventory.tenantId,
		planDigest: inventory.planDigest,
		operation: inventory.operation,
		evidenceRef: inventory.evidenceRef,
		resources: inventory.resources,
	};
}

function authority(
	limit = 3_000_000,
	settlementTrust = true,
	accountIds: readonly string[] = ["account-a"],
	entitlementIds: readonly string[] = [],
) {
	const dir = mkdtempSync(join(tmpdir(), "hobo-iac-budget-"));
	directories.push(dir);
	const ledger = createSqliteBudgetAdmissionAuthority({
		path: join(dir, "budget.sqlite"),
		now: () => NOW,
		...(settlementTrust
			? { iacPricedSettlementTrust: { verify: () => false } }
			: undefined),
		snapshot: create(BudgetLedgerSnapshotSchema, {
			identity: {
				tenantId: "tenant-a",
				budgetId: "hosting",
				periodId: "2026-01",
				policyRevision: "r1",
			},
			limitMicros: limit,
			observedAt: "2026-01-01T00:00:00Z",
			validUntil: END,
			providerAccounts: accountIds.map((providerAccountId) =>
				create(BudgetProviderAccountSchema, {
					providerAccountId,
					limitMicros: limit,
				}),
			),
			entitlements: entitlementIds.map((bucketId) =>
				create(BudgetEntitlementSchema, {
					bucketId,
					unit: "USD.micros",
					periodId: "2026-01",
					remainingUnits: 10_000_000,
					observedAt: "2026-01-01T00:00:00Z",
					validUntil: END,
				}),
			),
		}),
	});
	return ledger;
}

function dependencies(ledger: ReturnType<typeof authority>) {
	return {
		authority: ledger,
		now: () => NOW,
		verifyLiability: async () => true,
		authorize: async (input: {
			requestDigest: string;
			quote: { quoteId: string };
			identity: {
				tenantId: string;
				budgetId: string;
				periodId: string;
				policyRevision: string;
			};
		}) => {
			const gate: GateDecision = { effect: "allow", reasons: [], events: [] };
			return {
				gate,
				proof: create(HostingPolicyProofSchema, {
					requestDigest: input.requestDigest,
					quoteId: input.quote.quoteId,
					identity: input.identity,
					effect: "allow",
					policyHash: "sha256:policy",
					evidenceRef: "policy:1",
					obligationsSatisfied: true,
				}),
			};
		},
	};
}

describe("provider-neutral IaC target budget admission", () => {
	it("reserves a verified liability bound for a fixed-only developer model", async () => {
		const ledger = authority();
		try {
			const { inventory, evidence } = fixture();
			const scenario = makeScenario({
				charges: [fixedCharge("instance", "1")],
				meters: [],
				candidate: [workload("agreement-a", [])],
			});
			const charge = scenario.catalog?.rateCards[0]?.charges[0];
			const agreement = scenario.state?.agreements[0];
			const candidate = scenario.candidate[0];
			if (
				charge?.variant.case !== "fixed" ||
				agreement === undefined ||
				candidate === undefined
			)
				throw new Error("fixed-price fixture is incomplete");
			charge.variant.value.quantityDimension = "instance";
			agreement.quantities.instance = "0";
			candidate.quantities.instance = "1";
			rehashScenario(scenario);
			const deps = dependencies(ledger);
			const verifyLiability = vi.fn(deps.verifyLiability);
			const authorize = vi.fn(deps.authorize);
			const financial = createIacFinancialServices({
				...deps,
				verifyLiability,
				authorize,
				pricing: {
					modelId: "fixed-terms",
					revision: "1",
					scenario,
					bindings: [{ resourceId: "resource-a", candidateIndex: 0 }],
				},
				issueLiability: ({ priced }) => {
					evidence.inventoryHash = priced.inventoryHash;
					evidence.modelHash = priced.modelHash;
					evidence.quoteHash = priced.quote.quoteHash;
					return evidence;
				},
			});
			const plan = financialPlan(inventory);
			expect(financial.assess(plan)).toMatchObject({
				quote: {
					ok: true,
					quote: { incremental: { billed: { decimal: "1", currency: "USD" } } },
				},
				admissionPath: { kind: "bounded-budget" },
				budget: { evaluation: "not-evaluated", reservation: "not-created" },
			});
			expect(ledger.read(NOW).reservedMicros).toBe(0);
			expect(await financial.admit("fixed-priced", plan)).toMatchObject({
				status: "admitted",
				budget: { evaluation: "allowed", reservation: "held" },
			});
			expect(verifyLiability).toHaveBeenCalledOnce();
			expect(authorize).toHaveBeenCalledOnce();
			expect(ledger.read(NOW).reservedMicros).toBe(1_500_000);
		} finally {
			ledger.close();
		}
	});

	it.each([
		["missing declaration", "INCOMPLETE_FINANCIAL_STATE"],
		["cancellation", "PRICING_MODEL_UNSUPPORTED"],
		["placement action", "PRICING_MODEL_UNSUPPORTED"],
		["missing binding", "TARGET_PRICING_INCOMPLETE"],
	] as const)("does not bypass a destroy model with %s", async (kind, code) => {
		const ledger = authority();
		try {
			const { inventory, pricing, evidence } = fixture();
			if (pricing.state.case !== "model" || !pricing.state.value.scenario)
				throw new Error("missing model fixture");
			const scenario = clone(QuoteScenarioSchema, pricing.state.value.scenario);
			scenario.action = kind === "placement action" ? "place" : "destroy";
			if (kind !== "missing declaration")
				scenario.destroyCancelsAgreement = kind === "cancellation";
			const issueLiability = vi.fn(() => evidence);
			const authorizeUnpriced = vi.fn(() => {
				throw new Error("unexpected unpriced bypass");
			});
			const financial = createIacFinancialServices({
				...dependencies(ledger),
				issueLiability,
				destroyPricing: {
					modelId: "destroy-terms",
					revision: "1",
					scenario,
					bindings:
						kind === "missing binding"
							? []
							: [{ resourceId: "resource-a", candidateIndex: 0 }],
				},
				unpriced: { authorize: authorizeUnpriced },
			});
			const plan = { ...financialPlan(inventory), operation: "destroy" };
			expect(financial.assess(plan)).toMatchObject({
				quote: { ok: false, code },
				admissionPath: { kind: "unavailable", code },
			});
			expect(await financial.admit(`bad-destroy-${kind}`, plan)).toMatchObject({
				status: "denied",
				code,
				budget: { reservation: "not-created" },
			});
			expect(issueLiability).not.toHaveBeenCalled();
			expect(authorizeUnpriced).not.toHaveBeenCalled();
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});

	it("uses an independently declared destroy model and admits its bound quote", async () => {
		const ledger = authority();
		try {
			const { inventory, pricing, evidence } = fixture();
			if (pricing.state.case !== "model" || !pricing.state.value.scenario)
				throw new Error("missing model fixture");
			const scenario = pricing.state.value.scenario;
			const destroyScenario = clone(QuoteScenarioSchema, scenario);
			destroyScenario.action = "destroy";
			destroyScenario.destroyCancelsAgreement = false;
			const financial = createIacFinancialServices({
				...dependencies(ledger),
				issueLiability: () => evidence,
				pricing: {
					modelId: "terms",
					revision: "1",
					scenario,
					bindings: [{ resourceId: "resource-a", candidateIndex: 0 }],
				},
				destroyPricing: {
					modelId: "destroy-terms",
					revision: "2",
					scenario: destroyScenario,
					bindings: [{ resourceId: "resource-a", candidateIndex: 0 }],
				},
			});
			destroyScenario.destroyCancelsAgreement = true;
			const deployPlan = financialPlan(inventory);
			const destroyPlan = { ...deployPlan, operation: "destroy" };
			expect(financial.assess(deployPlan)).toMatchObject({
				quote: { ok: true, modelId: "terms" },
			});
			const assessed = financial.assess(destroyPlan);
			expect(assessed).toMatchObject({
				quote: { ok: true, modelId: "destroy-terms", revision: "2" },
				admissionPath: { kind: "bounded-budget" },
			});
			if (!assessed.quote.ok) throw new Error("destroy quote missing");
			evidence.inventoryHash = assessed.quote.inventoryHash;
			evidence.modelHash = assessed.quote.modelHash;
			evidence.quoteHash = assessed.quote.quote.quoteHash;
			expect(
				await financial.admit("destroy-priced", destroyPlan),
			).toMatchObject({
				status: "admitted",
				budget: { evaluation: "allowed", reservation: "held" },
			});
			expect(ledger.read(NOW).reservedMicros).toBe(1_500_000);
		} finally {
			ledger.close();
		}
	});

	it("does not admit a destroy operation using a placement estimate", async () => {
		const ledger = authority();
		try {
			const { inventory, pricing, evidence } = fixture();
			inventory.operation = "destroy";
			if (pricing.state.case !== "model" || !pricing.state.value.scenario)
				throw new Error("missing model fixture");
			const deps = dependencies(ledger);
			const verify = vi.fn(deps.verifyLiability);
			const authorize = vi.fn(deps.authorize);
			const issueLiability = vi.fn(() => evidence);
			const authorizeUnpriced = vi.fn(() => {
				throw new Error("unexpected unpriced bypass");
			});
			const financial = createIacFinancialServices({
				...deps,
				verifyLiability: verify,
				authorize,
				issueLiability,
				pricing: {
					modelId: "terms",
					revision: "1",
					scenario: pricing.state.value.scenario,
					bindings: [{ resourceId: "resource-a", candidateIndex: 0 }],
				},
				unpriced: { authorize: authorizeUnpriced },
			});
			const plan = financialPlan(inventory);
			expect(financial.assess(plan)).toMatchObject({
				quote: { ok: false, code: "PRICING_MODEL_UNSUPPORTED" },
				admissionPath: {
					kind: "unavailable",
					code: "PRICING_MODEL_UNSUPPORTED",
				},
				budget: { evaluation: "not-evaluated", reservation: "not-created" },
			});
			expect(await financial.admit("destroy-placement", plan)).toMatchObject({
				status: "denied",
				code: "PRICING_MODEL_UNSUPPORTED",
				budget: { reservation: "not-created" },
			});
			expect(issueLiability).not.toHaveBeenCalled();
			expect(authorizeUnpriced).not.toHaveBeenCalled();
			expect(verify).not.toHaveBeenCalled();
			expect(authorize).not.toHaveBeenCalled();
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});

	it.each([
		"migrate",
		"cancel",
		"rebalance",
		"place-removal",
		"place-source",
		"dispatch-removal",
		"dispatch-source",
	] as const)("denies unsupported %s pricing before liability or budget admission", async (action) => {
		const ledger = authority();
		try {
			const { inventory, pricing, evidence } = fixture();
			if (pricing.state.case !== "model" || !pricing.state.value.scenario)
				throw new Error("missing model fixture");
			const scenario = pricing.state.value.scenario;
			scenario.action = action.startsWith("place-")
				? "place"
				: action.startsWith("dispatch-")
					? "dispatch"
					: action;
			if (action.endsWith("-removal")) {
				const candidate = scenario.candidate[0];
				if (!candidate) throw new Error("missing candidate fixture");
				scenario.baseline = [structuredClone(candidate)];
				candidate.direction = "remove";
			}
			if (action.endsWith("-source"))
				scenario.sourceProviderAgreementIds = ["agreement-a"];
			if (!scenario.options) throw new Error("missing options fixture");
			scenario.options.allowCancellation = true;
			const deps = dependencies(ledger);
			const verify = vi.fn(deps.verifyLiability);
			const authorize = vi.fn(deps.authorize);
			expect(
				await admitIacTarget(
					{ requestId: `unsupported-${action}`, inventory, pricing, evidence },
					{ ...deps, verifyLiability: verify, authorize },
				),
			).toMatchObject({
				status: "denied",
				code: "PRICING_MODEL_UNSUPPORTED",
				budget: { reservation: "not-created" },
			});
			expect(verify).not.toHaveBeenCalled();
			expect(authorize).not.toHaveBeenCalled();
			const issueLiability = vi.fn(() => evidence);
			const authorizeUnpriced = vi.fn(() => {
				throw new Error("unexpected unpriced bypass");
			});
			const financial = createIacFinancialServices({
				...deps,
				verifyLiability: verify,
				authorize,
				issueLiability,
				pricing: {
					modelId: "terms",
					revision: "1",
					scenario,
					bindings: [{ resourceId: "resource-a", candidateIndex: 0 }],
				},
				unpriced: { authorize: authorizeUnpriced },
			});
			const plan = financialPlan(inventory);
			expect(financial.assess(plan)).toMatchObject({
				quote: { ok: false, code: "PRICING_MODEL_UNSUPPORTED" },
				admissionPath: {
					kind: "unavailable",
					code: "PRICING_MODEL_UNSUPPORTED",
				},
				budget: { evaluation: "not-evaluated", reservation: "not-created" },
			});
			expect(await financial.admit(`service-${action}`, plan)).toMatchObject({
				status: "denied",
				code: "PRICING_MODEL_UNSUPPORTED",
				budget: { reservation: "not-created" },
			});
			expect(issueLiability).not.toHaveBeenCalled();
			expect(authorizeUnpriced).not.toHaveBeenCalled();
			expect(verify).not.toHaveBeenCalled();
			expect(authorize).not.toHaveBeenCalled();
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});

	it("denies cross-currency credit basis before liability or budget admission", async () => {
		const ledger = authority();
		try {
			const { inventory, pricing, evidence } = fixture();
			if (pricing.state.case !== "model")
				throw new Error("missing model fixture");
			const scenario = makeScenario({
				charges: [perUnitCharge("runtime", "minute", "1")],
				candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
				credits: [creditState("credit-a", "acquisition", 0)],
			});
			const basis = scenario.state?.credits[0]?.remainingBasis;
			if (!basis) throw new Error("missing basis fixture");
			basis.currency = "EUR";
			rehashScenario(scenario);
			pricing.state.value.scenario = scenario;
			const deps = dependencies(ledger);
			const verify = vi.fn(deps.verifyLiability);
			const authorize = vi.fn(deps.authorize);
			expect(
				await admitIacTarget(
					{ requestId: "cross-currency-basis", inventory, pricing, evidence },
					{ ...deps, verifyLiability: verify, authorize },
				),
			).toMatchObject({
				status: "denied",
				code: "CROSS_CURRENCY",
				budget: { reservation: "not-created" },
			});
			expect(verify).not.toHaveBeenCalled();
			expect(authorize).not.toHaveBeenCalled();
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});

	it("denies invalid financial balances before liability or budget admission", async () => {
		const ledger = authority();
		try {
			const { inventory, pricing, evidence } = fixture();
			if (pricing.state.case !== "model")
				throw new Error("missing model fixture");
			const scenario = makeScenario({
				charges: [perUnitCharge("runtime", "minute", "1")],
				candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
				credits: [creditState("credit-a", "zero", 0)],
			});
			const face = scenario.state?.credits[0]?.grant?.faceValue?.value;
			if (face?.case !== "money") throw new Error("missing face value");
			face.value.decimal = "-1";
			rehashScenario(scenario);
			pricing.state.value.scenario = scenario;
			const deps = dependencies(ledger);
			const verify = vi.fn(deps.verifyLiability);
			const authorize = vi.fn(deps.authorize);
			expect(
				await admitIacTarget(
					{ requestId: "invalid-credit", inventory, pricing, evidence },
					{ ...deps, verifyLiability: verify, authorize },
				),
			).toMatchObject({
				status: "denied",
				code: "INVALID_PRICING_INPUT",
				budget: { reservation: "not-created" },
			});
			expect(verify).not.toHaveBeenCalled();
			expect(authorize).not.toHaveBeenCalled();
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});

	it("reserves spend commitments in currency units", async () => {
		const ledger = authority(3_000_000, true, ["account-a"], ["commitment-a"]);
		try {
			const { inventory, pricing, evidence } = fixture();
			if (pricing.state.case !== "model")
				throw new Error("missing model fixture");
			pricing.state.value.scenario = makeScenario({
				charges: [perUnitCharge("runtime", "minute", "1")],
				candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
				commitments: [commitmentState()],
			});
			const priced = quoteTargetPricing(inventory, pricing);
			if (!priced.ok) throw new Error(priced.reason);
			expect(priced.quote.consumption).toMatchObject([
				{
					sourceId: "commitment-a",
					kind: "commitment",
					quantity: { decimal: "4", unit: "USD" },
				},
			]);
			evidence.inventoryHash = priced.inventoryHash;
			evidence.modelHash = priced.modelHash;
			evidence.quoteHash = priced.quote.quoteHash;
			expect(
				await admitIacTarget(
					{ requestId: "commitment-units", inventory, pricing, evidence },
					dependencies(ledger),
				),
			).toMatchObject({
				status: "admitted",
				budget: { reservation: "held" },
			});
			expect(ledger.read(NOW).entitlements).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						bucketId: "commitment-a",
						unit: "USD.micros",
						reservedUnits: 4_000_000,
					}),
				]),
			);
		} finally {
			ledger.close();
		}
	});

	it("denies duplicate entitlement identities before liability or budget admission", async () => {
		const ledger = authority();
		try {
			const { inventory, pricing, evidence } = fixture();
			if (pricing.state.case !== "model")
				throw new Error("missing model fixture");
			pricing.state.value.scenario = makeScenario({
				charges: [perUnitCharge("runtime", "minute", "1")],
				candidate: [workload("agreement-a", [usage("minute", "15", "minute")])],
				credits: [
					creditState("shared", "zero", 0),
					creditState("shared", "zero", 0),
				],
			});
			const deps = dependencies(ledger);
			const verify = vi.fn(deps.verifyLiability);
			const authorize = vi.fn(deps.authorize);
			const decision = await admitIacTarget(
				{ requestId: "duplicate-credit", inventory, pricing, evidence },
				{ ...deps, verifyLiability: verify, authorize },
			);
			expect(decision).toMatchObject({
				status: "denied",
				code: "INVALID_PRICING_INPUT",
				budget: { reservation: "not-created" },
			});
			expect(verify).not.toHaveBeenCalled();
			expect(authorize).not.toHaveBeenCalled();
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});

	it("reserves the incremental credits calculated by the same rating version", async () => {
		const ledger = authority(
			3_000_000,
			true,
			["account-a"],
			["Z-credit", "a-credit"],
		);
		try {
			const { inventory, pricing, evidence } = fixture();
			if (pricing.state.case !== "model")
				throw new Error("missing model fixture");
			pricing.state.value.scenario = makeScenario({
				charges: [perUnitCharge("runtime", "minute", "1")],
				baseline: [workload("agreement-a", [usage("minute", "5", "minute")])],
				candidate: [workload("agreement-a", [usage("minute", "10", "minute")])],
				credits: [
					creditState("Z-credit", "zero", 0),
					creditState("a-credit", "acquisition", 0),
				],
			});
			const priced = quoteTargetPricing(inventory, pricing);
			if (!priced.ok) throw new Error(priced.reason);
			expect(priced.quote.ratingAlgorithmVersion).toBe("pricing-rating/v2");
			evidence.inventoryHash = priced.inventoryHash;
			evidence.modelHash = priced.modelHash;
			evidence.quoteHash = priced.quote.quoteHash;
			expect(
				await admitIacTarget(
					{ requestId: "credit-order", inventory, pricing, evidence },
					dependencies(ledger),
				),
			).toMatchObject({ status: "admitted", budget: { reservation: "held" } });
			expect(ledger.read(NOW).entitlements).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						bucketId: "Z-credit",
						reservedUnits: 5_000_000,
					}),
					expect.objectContaining({
						bucketId: "a-credit",
						reservedUnits: 5_000_000,
					}),
				]),
			);
		} finally {
			ledger.close();
		}
	});

	it.each([
		false,
		true,
	])("admits all matching mixed-case accounts regardless of evidence order (reverse=%s)", async (reverse) => {
		const ledger = authority(3_000_000, true, ["Z-account", "a-account"]);
		try {
			const { inventory, pricing, evidence } = fixture();
			if (pricing.state.case !== "model" || !pricing.state.value.scenario)
				throw new Error("missing model fixture");
			const model = pricing.state.value;
			const scenario = model.scenario;
			if (!scenario) throw new Error("missing scenario fixture");
			const agreement = scenario.state?.agreements[0];
			const first = scenario.candidate[0];
			const resource = inventory.resources[0];
			const liability = evidence.providerAccounts[0];
			if (!agreement || !scenario.state || !first || !resource || !liability)
				throw new Error("missing account fixture");
			agreement.providerAccountRef = "Z-account";
			resource.providerAccountRef = "Z-account";
			scenario.state.agreements.push({
				...agreement,
				id: "agreement-b",
				providerAccountRef: "a-account",
			});
			scenario.candidate.push({ ...first, agreementRef: "agreement-b" });
			inventory.resources.push({
				...resource,
				resourceId: "resource-b",
				providerAccountRef: "a-account",
			});
			model.bindings.push({
				$typeName: "hobo.pricing.v1.TargetPricingBinding",
				resourceId: "resource-b",
				candidateIndex: 1,
			});
			rehashScenario(scenario);
			const priced = quoteTargetPricing(inventory, pricing);
			if (!priced.ok) throw new Error(priced.reason);
			evidence.inventoryHash = priced.inventoryHash;
			evidence.modelHash = priced.modelHash;
			evidence.quoteHash = priced.quote.quoteHash;
			evidence.maximumMicros = 2_500_000;
			evidence.providerAccounts = [
				{
					...liability,
					providerAccountId: "Z-account",
					liabilityMicros: 1_250_000,
				},
				{
					...liability,
					providerAccountId: "a-account",
					liabilityMicros: 1_250_000,
				},
			];
			if (reverse) evidence.providerAccounts.reverse();
			expect(
				await admitIacTarget(
					{ requestId: `joint-case-${reverse}`, inventory, pricing, evidence },
					dependencies(ledger),
				),
			).toMatchObject({ status: "admitted", budget: { reservation: "held" } });
			expect(ledger.read(NOW).reservedMicros).toBe(2_500_000);
			expect(ledger.read(NOW).providerAccounts).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						providerAccountId: "Z-account",
						reservedMicros: 1_250_000,
					}),
					expect.objectContaining({
						providerAccountId: "a-account",
						reservedMicros: 1_250_000,
					}),
				]),
			);
		} finally {
			ledger.close();
		}
	});

	it.each([
		"issueLiability",
		"authorize",
		"verifyLiability",
	] as const)("keeps the priced path after the original %s is replaced", async (key) => {
		const ledger = authority();
		try {
			const { inventory, pricing, evidence } = fixture();
			if (pricing.state.case !== "model" || !pricing.state.value.scenario)
				throw new Error("fixture model missing");
			const options = {
				...dependencies(ledger),
				issueLiability: () => evidence,
				pricing: {
					modelId: "terms",
					revision: "1",
					scenario: pricing.state.value.scenario,
					bindings: [{ resourceId: "resource-a", candidateIndex: 0 }],
				},
			};
			const financial = createIacFinancialServices(options);
			let reads = 0;
			Object.defineProperty(options, key, {
				get() {
					reads++;
					throw new Error("substituted financial capability");
				},
			});
			const plan = financialPlan(inventory);
			expect(financial.assess(plan).admissionPath).toEqual({
				kind: "bounded-budget",
				budget: "evaluation-required",
			});
			expect(await financial.admit(`captured-${key}`, plan)).toMatchObject({
				status: "admitted",
				budget: { reservation: "held" },
			});
			expect(reads).toBe(0);
		} finally {
			ledger.close();
		}
	});

	it("does not advertise priced capabilities added after construction", async () => {
		const ledger = authority();
		try {
			const { inventory, pricing, evidence } = fixture();
			if (pricing.state.case !== "model" || !pricing.state.value.scenario)
				throw new Error("fixture model missing");
			const options = {
				authority: ledger,
				now: () => NOW,
				pricing: {
					modelId: "terms",
					revision: "1",
					scenario: pricing.state.value.scenario,
					bindings: [{ resourceId: "resource-a", candidateIndex: 0 }],
				},
			};
			const financial = createIacFinancialServices(options);
			Object.assign(options, dependencies(ledger), {
				issueLiability: () => evidence,
			});
			const plan = financialPlan(inventory);
			expect(financial.assess(plan).admissionPath).toEqual({
				kind: "unavailable",
				code: "FINANCIAL_CONFIGURATION_INCOMPLETE",
			});
			expect(await financial.admit("added-capabilities", plan)).toMatchObject({
				status: "denied",
				code: "FINANCIAL_CONFIGURATION_INCOMPLETE",
				budget: { reservation: "not-created" },
			});
		} finally {
			ledger.close();
		}
	});

	it.each([
		"settlement",
		"liability",
	])("discloses budget evaluation as pending when %s trust may refuse admission", async (missing) => {
		const ledger = authority(3_000_000, missing !== "settlement");
		try {
			const { inventory, pricing, evidence } = fixture();
			if (pricing.state.case !== "model" || !pricing.state.value.scenario)
				throw new Error("fixture model missing");
			const deps = dependencies(ledger);
			const financial = createIacFinancialServices({
				...deps,
				verifyLiability: () => missing !== "liability",
				pricing: {
					modelId: "terms",
					revision: "1",
					scenario: pricing.state.value.scenario,
					bindings: [{ resourceId: "resource-a", candidateIndex: 0 }],
				},
				issueLiability: () => evidence,
			});
			const plan = financialPlan(inventory);
			expect(financial.assess(plan)).toMatchObject({
				quote: { ok: true },
				admissionPath: {
					kind: "bounded-budget",
					budget: "evaluation-required",
				},
				budget: { evaluation: "not-evaluated", reservation: "not-created" },
			});
			expect(await financial.admit(`missing-${missing}`, plan)).toMatchObject({
				status: "denied",
				code:
					missing === "settlement"
						? "budget.settlement-unavailable"
						: "LIABILITY_EVIDENCE_UNVERIFIED",
				budget: { evaluation: "unavailable", reservation: "not-created" },
			});
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});
	it("refuses a priced target before execution when settlement trust is absent", async () => {
		const ledger = authority(3_000_000, false);
		try {
			const result = await admitIacTarget(
				{ requestId: "no-settlement-trust", ...fixture() },
				dependencies(ledger),
			);
			expect(result).toMatchObject({
				status: "denied",
				code: "budget.settlement-unavailable",
				budget: { evaluation: "unavailable", reservation: "not-created" },
			});
			expect(ledger.lookup("iac:no-settlement-trust")).toBeUndefined();
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});
	/* oxlint-disable anti-slop/no-object-parameters, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: intentionally malformed values test the external request boundary. */
	it("rejects proxied financial configuration and input without executing traps or authorities", async () => {
		let traps = 0;
		let authorityCalls = 0;
		const hostile = (value: object) =>
			new Proxy(value, {
				get() {
					traps++;
					throw new Error("trap");
				},
				getOwnPropertyDescriptor() {
					traps++;
					throw new Error("trap");
				},
				getPrototypeOf() {
					traps++;
					throw new Error("trap");
				},
				ownKeys() {
					traps++;
					throw new Error("trap");
				},
			});
		expect(() => createIacFinancialServices(hostile({}) as never)).toThrow();
		expect(() =>
			createIacFinancialServices(Object.create(hostile({})) as never),
		).toThrow();
		const financial = createIacFinancialServices({
			authority: {
				get persistence() {
					authorityCalls++;
					throw new Error("authority");
				},
			},
			now: () => {
				authorityCalls++;
				throw new Error("clock");
			},
			verifyLiability: () => {
				authorityCalls++;
				throw new Error("liability");
			},
			authorize: () => {
				authorityCalls++;
				throw new Error("policy");
			},
			issueLiability: () => {
				authorityCalls++;
				throw new Error("issuer");
			},
		} as never);
		const { inventory } = fixture();
		const plan = financialPlan(inventory);
		const accessor = Object.defineProperty({ ...plan }, "targetId", {
			enumerable: true,
			get() {
				traps++;
				throw new Error("trap");
			},
		});
		const malformed: unknown[] = [
			null,
			hostile(plan),
			accessor,
			{ ...plan, resources: [hostile(inventory.resources[0] ?? {})] },
			{ ...plan, unknownScope: "additional account" },
			{ ...plan, complete: false },
			{ ...plan, complete: true },
		];
		for (const plan of malformed) {
			expect(() => financial.assess(plan as never)).toThrow();
			expect(await financial.admit("request", plan as never)).toMatchObject({
				status: "denied",
				code: "REQUEST_INVALID",
				budget: { reservation: "not-created" },
			});
		}
		for (const expected of [
			hostile({}),
			{ targetId: "yard-a", unexpected: true },
			{ [Symbol("unknown")]: true },
		])
			expect(
				await financial.admit("request", plan, expected as never),
			).toMatchObject({ status: "denied", code: "REQUEST_INVALID" });
		expect(await financial.admit("a".repeat(5000), plan)).toMatchObject({
			status: "denied",
			code: "REQUEST_INVALID",
			requestId: "",
		});
		expect(traps).toBe(0);
		expect(authorityCalls).toBe(0);
	});

	it("keeps the captured plan identity when a liability issuer completes later", async () => {
		const { inventory, pricing } = fixture();
		const plan = financialPlan(inventory);
		if (pricing.state.case !== "model" || !pricing.state.value.scenario)
			throw new Error("fixture model missing");
		let entered = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release = () => {};
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const financial = createIacFinancialServices({
			authority: {} as never,
			now: () => NOW,
			verifyLiability: () => false,
			authorize: () => {
				throw new Error("unexpected policy");
			},
			issueLiability: async () => {
				entered();
				await wait;
				throw new Error("issuer unavailable");
			},
			pricing: {
				modelId: pricing.state.value.modelId,
				revision: pricing.state.value.revision,
				scenario: pricing.state.value.scenario,
				bindings: [{ resourceId: "resource-a", candidateIndex: 0 }],
			},
		});
		const pending = financial.admit("request", plan);
		await started;
		plan.targetId = "substituted";
		release();
		expect(await pending).toMatchObject({
			status: "denied",
			code: "LIABILITY_SERVICE_UNAVAILABLE",
			targetId: "yard-a",
		});
	});

	it("pins host authority and callbacks with a detached immutable receiver", async () => {
		const ledger = authority();
		const alternate = authority();
		try {
			const { inventory, pricing, evidence } = fixture();
			if (pricing.state.case !== "model" || !pricing.state.value.scenario)
				throw new Error("fixture model missing");
			const deps = dependencies(ledger);
			const calls: string[] = [];
			let traps = 0;
			let entered = () => {};
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			let release = () => {};
			const waiting = new Promise<void>((resolve) => {
				release = resolve;
			});
			const options = {
				authority: ledger,
				now() {
					expect(this).not.toBe(options);
					expect(Object.isFrozen(this)).toBe(true);
					expect(this.authority).toBe(ledger);
					calls.push("now");
					return NOW;
				},
				verifyLiability() {
					expect(this).not.toBe(options);
					expect(this.authority).toBe(ledger);
					calls.push("verify");
					return true;
				},
				authorize(input: Parameters<typeof deps.authorize>[0]) {
					expect(this).not.toBe(options);
					expect(this.authority).toBe(ledger);
					calls.push("policy");
					return deps.authorize(input);
				},
				async issueLiability() {
					expect(this).not.toBe(options);
					expect(this.authority).toBe(ledger);
					calls.push("issue");
					entered();
					await waiting;
					expect(this.authority).toBe(ledger);
					expect(this.now()).toBe(NOW);
					expect(Object.isFrozen(this.pricing)).toBe(true);
					expect(Object.isFrozen(this.pricing.bindings)).toBe(true);
					return evidence;
				},
				pricing: {
					modelId: "terms",
					revision: "1",
					scenario: pricing.state.value.scenario,
					bindings: [{ resourceId: "resource-a", candidateIndex: 0 }],
				},
			};
			for (const callback of [
				options.now,
				options.verifyLiability,
				options.authorize,
				options.issueLiability,
			])
				for (const key of ["call", "bind"])
					Object.defineProperty(callback, key, {
						get() {
							traps++;
							throw new Error("trap");
						},
					});
			const financial = createIacFinancialServices(options);
			const pending = financial.admit("request", financialPlan(inventory));
			await started;
			options.authority = alternate;
			options.now = () => {
				throw new Error("substituted clock");
			};
			options.verifyLiability = () => {
				throw new Error("substituted verifier");
			};
			options.authorize = () => {
				throw new Error("substituted policy");
			};
			options.issueLiability = () => {
				throw new Error("substituted issuer");
			};
			release();
			const result = await pending;
			expect(result.status).toBe("admitted");
			expect(ledger.read(NOW).reservedMicros).toBeGreaterThan(0);
			expect(alternate.read(NOW).reservedMicros).toBe(0);
			expect(calls).toEqual(
				expect.arrayContaining(["issue", "now", "verify", "policy"]),
			);
			expect(traps).toBe(0);
		} finally {
			ledger.close();
			alternate.close();
		}
	});

	it("refuses accessor-backed, proxied, and extra financial host fields before traps", () => {
		let traps = 0;
		const base = {
			authority: {},
			now: () => NOW,
			verifyLiability: () => true,
			authorize: () => undefined,
			issueLiability: () => undefined,
		};
		for (const key of [
			"authority",
			"now",
			"verifyLiability",
			"authorize",
			"issueLiability",
		] as const) {
			const accessor = Object.defineProperty({ ...base }, key, {
				enumerable: true,
				get() {
					traps++;
					throw new Error("trap");
				},
			});
			expect(() => createIacFinancialServices(accessor as never)).toThrow();
			const proxy = new Proxy(key === "authority" ? {} : () => true, {
				get() {
					traps++;
					throw new Error("trap");
				},
				apply() {
					traps++;
					throw new Error("trap");
				},
			});
			expect(() =>
				createIacFinancialServices({ ...base, [key]: proxy } as never),
			).toThrow();
		}
		expect(() =>
			createIacFinancialServices({ ...base, extraPolicy: true } as never),
		).toThrow();
		expect(() =>
			createIacFinancialServices({ ...base, [Symbol("extra")]: true } as never),
		).toThrow();
		expect(traps).toBe(0);
	});
	/* oxlint-enable anti-slop/no-object-parameters, anti-slop/require-safety-comment-for-type-assertion */

	it.each([
		"inventory",
		"resource",
	])("rejects unknown %s fields before an authority can be consulted", async (kind) => {
		const ledger = authority();
		try {
			const request = fixture();
			const value =
				kind === "inventory"
					? request.inventory
					: request.inventory.resources[0];
			if (value === undefined) throw new Error("missing fixture resource");
			Object.defineProperty(value, "unrecognized", {
				value: "not part of the reviewed inventory",
				enumerable: true,
			});
			let calls = 0;
			const authorityRead = vi.spyOn(ledger, "read");
			const result = await admitIacTarget(
				{ requestId: "invalid-inventory", ...request },
				{
					...dependencies(ledger),
					verifyLiability: () => {
						calls++;
						return true;
					},
					authorize: () => {
						calls++;
						throw new Error("must not authorize");
					},
				},
			);
			expect(result).toMatchObject({
				status: "denied",
				code: "TARGET_INVENTORY_INCOMPLETE",
				budget: { evaluation: "unavailable", reservation: "not-created" },
			});
			expect(calls).toBe(0);
			expect(authorityRead).not.toHaveBeenCalled();
			authorityRead.mockRestore();
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});

	it.each([
		"request-proxy",
		"request-id",
		"inventory",
		"inventory-proxy",
		"inventory-target-id",
		"inventory-resource-proxy",
		"evidence",
		"unknown-envelope",
		"symbol-envelope",
	])("denies uninspectable %s without executing caller traps", async (kind) => {
		const ledger = authority();
		try {
			let calls = 0;
			const trap = () => {
				calls++;
				throw new Error("caller code must not run");
			};
			let request = { requestId: "invalid-input", ...fixture() };
			if (kind === "request-proxy")
				request = new Proxy(request, {
					get: trap,
					getOwnPropertyDescriptor: trap,
				});
			if (kind === "request-id")
				Object.defineProperty(request, "requestId", {
					get: trap,
					enumerable: true,
				});
			if (kind === "inventory")
				Object.defineProperty(request, "inventory", {
					get: trap,
					enumerable: true,
				});
			if (kind === "inventory-proxy")
				request.inventory = new Proxy(request.inventory, { get: trap });
			if (kind === "inventory-target-id")
				Object.defineProperty(request.inventory, "targetId", {
					get: trap,
					enumerable: true,
				});
			if (kind === "inventory-resource-proxy") {
				const resource = request.inventory.resources[0];
				if (resource === undefined) throw new Error("missing resource");
				request.inventory.resources[0] = new Proxy(resource, {
					get: trap,
					getPrototypeOf: trap,
					ownKeys: trap,
				});
			}
			if (kind === "evidence")
				Object.defineProperty(request, "evidence", {
					get: trap,
					enumerable: true,
				});
			if (kind === "unknown-envelope")
				Object.defineProperty(request, "additionalPolicy", {
					get: trap,
					enumerable: true,
				});
			if (kind === "symbol-envelope")
				Object.defineProperty(request, Symbol("additional policy"), {
					value: true,
				});
			const authorityRead = vi.spyOn(ledger, "read");
			const result = await admitIacTarget(request, {
				...dependencies(ledger),
				verifyLiability: () => {
					calls++;
					return true;
				},
				authorize: () => {
					calls++;
					throw new Error("must not authorize");
				},
			});
			expect(result).toMatchObject({
				status: "denied",
				budget: { evaluation: "unavailable", reservation: "not-created" },
			});
			expect(calls).toBe(0);
			expect(authorityRead).not.toHaveBeenCalled();
			authorityRead.mockRestore();
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});

	it.each([
		"null",
		"missing-accounts",
		"unknown-field",
		"accessor",
	])("rejects malformed liability evidence (%s) without calling trust or policy", async (kind) => {
		const ledger = authority();
		try {
			const request = fixture();
			let calls = 0;
			if (kind === "null")
				Object.defineProperty(request, "evidence", { value: null });
			if (kind === "missing-accounts")
				Object.defineProperty(request.evidence, "providerAccounts", {
					value: undefined,
					enumerable: true,
				});
			if (kind === "unknown-field")
				Object.defineProperty(
					request.evidence.providerAccounts[0],
					"otherLiability",
					{ value: 100, enumerable: true },
				);
			if (kind === "accessor")
				Object.defineProperty(request.evidence, "extra", {
					enumerable: true,
					get: () => {
						calls++;
						return 100;
					},
				});
			const deps = dependencies(ledger);
			expect(
				await admitIacTarget(
					{ requestId: "invalid-evidence", ...request },
					{
						...deps,
						verifyLiability: () => {
							calls++;
							return true;
						},
						authorize: (input) => {
							calls++;
							return deps.authorize(input);
						},
					},
				),
			).toMatchObject({
				status: "denied",
				code: "LIABILITY_EVIDENCE_INVALID",
				budget: { reservation: "not-created" },
			});
			expect(calls).toBe(0);
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});

	it.each([
		"missing-gate",
		"missing-reasons",
		"unknown-gate",
		"unknown-decision",
		"non-json-event",
		"truthy-obligation",
		"unknown-proof-field",
		"accessor",
	])("rejects malformed policy decisions (%s) before reserving", async (kind) => {
		const ledger = authority();
		try {
			const deps = dependencies(ledger);
			let getters = 0;
			const result = await admitIacTarget(
				{ requestId: "invalid-policy", ...fixture() },
				{
					...deps,
					authorize: async (input) => {
						const policy = await deps.authorize(input);
						if (kind === "missing-gate")
							Object.defineProperty(policy, "gate", { value: undefined });
						if (kind === "missing-reasons")
							Object.defineProperty(policy.gate, "reasons", {
								value: undefined,
							});
						if (kind === "unknown-gate")
							Object.defineProperty(policy.gate, "condition", {
								value: "unfulfilled",
								enumerable: true,
							});
						if (kind === "unknown-decision")
							Object.defineProperty(policy, "condition", {
								value: undefined,
								enumerable: true,
							});
						if (kind === "non-json-event")
							policy.gate.events.push(
								Object.defineProperty({}, "future", {
									value: undefined,
									enumerable: true,
								}),
							);
						if (kind === "truthy-obligation")
							Object.defineProperty(policy.proof, "obligationsSatisfied", {
								value: "yes",
							});
						if (kind === "unknown-proof-field")
							Object.defineProperty(policy.proof, "unfulfilledObligation", {
								value: true,
								enumerable: true,
							});
						if (kind === "accessor")
							Object.defineProperty(policy, "proof", {
								enumerable: true,
								get: () => {
									getters++;
									return undefined;
								},
							});
						return policy;
					},
				},
			);
			expect(result).toMatchObject({
				status: "denied",
				code: "POLICY_UNAVAILABLE",
				budget: { reservation: "not-created" },
			});
			expect(getters).toBe(0);
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});
	it.each([
		"surcharge",
		"length",
		"undefined",
		"array-property",
		"sparse-array",
		"accessor",
		"prototype",
		"cycle",
		"oversized",
	])("rejects raw model %s before any normalization or authority call", (kind) => {
		const ledger = authority();
		try {
			const { pricing, evidence } = fixture();
			if (pricing.state.case !== "model" || !pricing.state.value.scenario)
				throw new Error("fixture model missing");
			const scenario = pricing.state.value.scenario;
			const charges = scenario.catalog?.rateCards[0]?.charges;
			const charge = charges?.[0];
			if (!charges || !charge) throw new Error("fixture charge missing");
			let calls = 0;
			if (kind === "surcharge")
				Object.defineProperty(charge, "surcharge", {
					value: { amount: "100", currency: "USD" },
					enumerable: true,
				});
			if (kind === "length")
				Object.defineProperty(charge, "length", {
					value: 100,
					enumerable: true,
				});
			if (kind === "undefined")
				Object.defineProperty(charge, "unknown", {
					value: undefined,
					enumerable: true,
				});
			if (kind === "array-property")
				Object.defineProperty(charges, "extra", {
					value: "fee",
					enumerable: true,
				});
			if (kind === "sparse-array") charges.length = 2;
			if (kind === "accessor")
				Object.defineProperty(charge, "fee", {
					enumerable: true,
					get: () => {
						calls++;
						return "100";
					},
				});
			if (kind === "prototype") Object.setPrototypeOf(charge, { fee: 100 });
			if (kind === "cycle")
				Object.defineProperty(charge, "cycle", {
					value: scenario,
					enumerable: true,
				});
			if (kind === "oversized") charges.length = 1025;
			const deps = dependencies(ledger);
			expect(() =>
				createIacFinancialServices({
					...deps,
					pricing: {
						modelId: "terms",
						revision: "1",
						scenario,
						bindings: [{ resourceId: "resource-a", candidateIndex: 0 }],
					},
					issueLiability: () => {
						calls++;
						return evidence;
					},
				}),
			).toThrow();
			expect(calls).toBe(0);
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});

	it.each([
		"pricing",
		"destroyPricing",
	] as const)("rejects malformed %s without invoking its getter or treating it as unavailable", (key) => {
		const ledger = authority();
		try {
			const { evidence } = fixture();
			let calls = 0;
			const options = {
				...dependencies(ledger),
				issueLiability: () => evidence,
			};
			Object.defineProperty(options, key, {
				enumerable: true,
				configurable: true,
				get: () => {
					calls++;
					return undefined;
				},
			});
			expect(() => createIacFinancialServices(options)).toThrow();
			expect(calls).toBe(0);
			Object.defineProperty(options, key, {
				value: undefined,
				enumerable: true,
			});
			expect(() => createIacFinancialServices(options)).toThrow();
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});

	it("accepts intact generated pricing data at the broker entrypoint", () => {
		const ledger = authority();
		try {
			const { inventory, pricing, evidence } = fixture();
			if (pricing.state.case !== "model" || !pricing.state.value.scenario)
				throw new Error("fixture model missing");
			const financial = createIacFinancialServices({
				...dependencies(ledger),
				pricing: {
					modelId: "terms",
					revision: "1",
					scenario: pricing.state.value.scenario,
					bindings: [{ resourceId: "resource-a", candidateIndex: 0 }],
				},
				issueLiability: () => evidence,
			});
			expect(financial.assess(financialPlan(inventory))).toMatchObject({
				quote: { ok: true },
				budget: { evaluation: "not-evaluated", reservation: "not-created" },
			});
		} finally {
			ledger.close();
		}
	});

	it("rejects pricing that was altered after construction before liability or policy evaluation", async () => {
		const ledger = authority();
		try {
			const request = fixture();
			if (request.pricing.state.case !== "model")
				throw new Error("model missing");
			const charge =
				request.pricing.state.value.scenario?.catalog?.rateCards[0]?.charges[0];
			if (!charge) throw new Error("charge missing");
			Object.defineProperty(charge, "surcharge", {
				value: "100",
				enumerable: true,
			});
			let calls = 0;
			const deps = dependencies(ledger);
			expect(
				await admitIacTarget(
					{ requestId: "bad-model", ...request },
					{
						...deps,
						verifyLiability: () => {
							calls++;
							return true;
						},
						authorize: (input) => {
							calls++;
							return deps.authorize(input);
						},
					},
				),
			).toMatchObject({
				status: "denied",
				code: "PRICING_MODEL_INVALID",
				budget: { reservation: "not-created" },
			});
			expect(calls).toBe(0);
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});
	it.each([
		"verified",
		1,
		{},
		undefined,
		false,
	])("requires literal true from liability trust (%s)", async (value) => {
		const ledger = authority();
		try {
			const deps = dependencies(ledger);
			let policyCalls = 0;
			for (const asynchronous of [false, true]) {
				const decision = await admitIacTarget(
					{ requestId: "malformed-verifier", ...fixture() },
					{
						...deps,
						verifyLiability: () =>
							// @ts-expect-error Exercise a malformed host result at the trust boundary.
							asynchronous ? Promise.resolve(value) : value,
						authorize: (input) => {
							policyCalls++;
							return deps.authorize(input);
						},
					},
				);
				expect(decision).toMatchObject({
					status: "denied",
					code: "LIABILITY_EVIDENCE_UNVERIFIED",
					budget: { evaluation: "unavailable", reservation: "not-created" },
				});
				expect(policyCalls).toBe(0);
				expect(ledger.read(NOW).reservedMicros).toBe(0);
			}
		} finally {
			ledger.close();
		}
	});

	it("revalidates a priced service receipt against the exact durable claim", async () => {
		const ledger = authority();
		try {
			const { inventory, pricing, evidence } = fixture();
			if (pricing.state.case !== "model") throw new Error("model missing");
			const source = pricing.state.value;
			const scenario = source.scenario;
			if (!scenario) throw new Error("scenario missing");
			const bindings = source.bindings.map((binding) => {
				if (binding.candidateIndex === undefined)
					throw new Error("binding missing");
				return {
					resourceId: binding.resourceId,
					candidateIndex: binding.candidateIndex,
				};
			});
			const deps = dependencies(ledger);
			const financial = createIacFinancialServices({
				...deps,
				pricing: {
					modelId: source.modelId,
					revision: source.revision,
					scenario,
					bindings,
				},
				issueLiability: ({ priced }) => {
					const copy = clone(IacTargetLiabilityEvidenceSchema, evidence);
					copy.inventoryHash = priced.inventoryHash;
					copy.modelHash = priced.modelHash;
					copy.quoteHash = priced.quote.quoteHash;
					return copy;
				},
			});
			const plan = {
				targetId: inventory.targetId,
				tenantId: inventory.tenantId,
				planDigest: inventory.planDigest,
				evidenceRef: inventory.evidenceRef,
				resources: inventory.resources,
			};
			expect(financial.assess(plan)).toMatchObject({
				quote: { ok: true, source: "developer-supplied" },
				budget: { evaluation: "not-evaluated", reservation: "not-created" },
				admissionPath: {
					kind: "bounded-budget",
					budget: "evaluation-required",
				},
				providerCoverage: {
					basis: "declared-inventory",
					providers: [{ providerId: "sandbox", status: "quoted" }],
				},
			});
			expect(ledger.read(NOW).reservedMicros).toBe(0);
			const withoutHost = createIacFinancialServices({
				authority: ledger,
				now: () => NOW,
				pricing: {
					modelId: source.modelId,
					revision: source.revision,
					scenario,
					bindings,
				},
			});
			expect(withoutHost.assess(plan)).toMatchObject({
				admissionPath: {
					kind: "unavailable",
					code: "FINANCIAL_CONFIGURATION_INCOMPLETE",
				},
			});
			expect(await withoutHost.admit("unconfigured", plan)).toMatchObject({
				status: "denied",
				code: "FINANCIAL_CONFIGURATION_INCOMPLETE",
			});
			let unpricedCalls = 0;
			const invalidModel = createIacFinancialServices({
				authority: ledger,
				now: () => NOW,
				pricing: {
					modelId: source.modelId,
					revision: source.revision,
					scenario,
					bindings: [],
				},
				unpriced: {
					authorize: () => {
						unpricedCalls++;
						throw new Error("unexpected bypass");
					},
				},
			});
			expect(invalidModel.assess(plan)).toMatchObject({
				admissionPath: {
					kind: "unavailable",
					code: "TARGET_PRICING_INCOMPLETE",
				},
			});
			expect(await invalidModel.admit("incomplete", plan)).toMatchObject({
				status: "denied",
				code: "TARGET_PRICING_INCOMPLETE",
			});
			expect(unpricedCalls).toBe(0);
			const admission = await financial.admit("priced-service", plan);
			expect(admission.status).toBe("admitted");
			expect(await financial.revalidate(admission, plan)).toBe(true);
			for (const value of [
				false,
				undefined,
				null,
				"true",
				1,
				{},
				Promise.resolve("true"),
			]) {
				const bad = createIacFinancialServices({
					authority: {
						...ledger,
						// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: model a malformed JavaScript authority at the trust boundary.
						revalidatePriced: () => value as never,
					},
					now: () => NOW,
					pricing: {
						modelId: source.modelId,
						revision: source.revision,
						scenario,
						bindings,
					},
				});
				expect(await bad.revalidate(admission, plan)).toBe(false);
				expect(ledger.read(NOW).reservedMicros).toBe(1_500_000);
			}
			expect(
				await financial.revalidate(
					{ ...admission, quoteHash: `sha256:${"f".repeat(64)}` },
					plan,
				),
			).toBe(false);
			const state = ledger.read(NOW);
			if (!state.identity) throw new Error("identity missing");
			state.identity.policyRevision = "r2";
			ledger.configure(state, state.seq, NOW);
			expect(await financial.revalidate(admission, plan)).toBe(false);
		} finally {
			ledger.close();
		}
	});

	it("refuses an unknown price before any financial hold is created", async () => {
		const ledger = authority();
		try {
			const request = fixture();
			request.pricing = targetPricingUnavailable("no pricing model");
			const decision = await admitIacTarget(
				{ requestId: "unknown", ...request },
				dependencies(ledger),
			);
			expect(decision).toMatchObject({
				status: "denied",
				code: "PRICING_MODEL_UNAVAILABLE",
				budget: { evaluation: "unavailable", reservation: "not-created" },
			});
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});

	it("reserves the authenticated bound and claims exactly one execution", async () => {
		const ledger = authority();
		try {
			const request = { requestId: "priced", ...fixture() };
			const result = await admitIacTarget(request, dependencies(ledger));
			expect(result).toMatchObject({
				status: "admitted",
				budget: { evaluation: "allowed", reservation: "held" },
				quote: { totalMicros: 1_000_000, liabilityBoundMicros: 1_500_000 },
				reservation: { reservedMicros: 1_500_000 },
			});
			expect(ledger.read(NOW).reservedMicros).toBe(1_500_000);
			const checked = {
				reservationId: "iac:priced",
				requestId: "priced",
				targetId: "yard-a",
				tenantId: "tenant-a",
				requestDigest: result.requestDigest,
				planDigest: request.inventory.planDigest,
				inventoryHash: result.inventoryHash,
				modelHash: result.modelHash,
				quoteHash: result.quoteHash,
				now: NOW,
			};
			expect(ledger.revalidatePriced(checked)).toBe(true);
			expect(
				ledger.revalidatePriced({
					...checked,
					modelHash: `sha256:${"f".repeat(64)}`,
				}),
			).toBe(false);
			expect(ledger.revalidatePriced({ ...checked, targetId: "other" })).toBe(
				false,
			);
			expect(await admitIacTarget(request, dependencies(ledger))).toMatchObject(
				{ status: "replay", code: "EXECUTION_ALREADY_CLAIMED" },
			);
			expect(ledger.read(NOW).reservedMicros).toBe(1_500_000);
		} finally {
			ledger.close();
		}
	});

	it.each([
		"wrong-plan",
		"expired",
		"unverified",
		"too-small",
	] as const)("refuses %s liability evidence without a hold", async (kind) => {
		const ledger = authority();
		try {
			const request = { requestId: `bad-${kind}`, ...fixture() };
			if (kind === "wrong-plan")
				request.evidence.planDigest = `sha256:${"b".repeat(64)}`;
			if (kind === "expired") request.evidence.validUntil = NOW;
			if (kind === "too-small") request.evidence.maximumMicros = 1;
			const deps = dependencies(ledger);
			if (kind === "unverified") deps.verifyLiability = async () => false;
			expect(await admitIacTarget(request, deps)).toMatchObject({
				status: "denied",
			});
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});

	it("does not reserve when a budget policy requires approval", async () => {
		const ledger = authority();
		try {
			const deps = dependencies(ledger);
			const allow = deps.authorize;
			deps.authorize = async (input) => {
				const result = await allow(input);
				return {
					...result,
					gate: { ...result.gate, effect: "require-approval" },
				};
			};
			expect(
				await admitIacTarget({ requestId: "approval", ...fixture() }, deps),
			).toMatchObject({ status: "denied", code: "POLICY_NOT_ALLOWED" });
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});

	it("returns a definitive budget refusal before making a hold", async () => {
		const ledger = authority(1_000_000);
		try {
			const decision = await admitIacTarget(
				{ requestId: "exhausted", ...fixture() },
				dependencies(ledger),
			);
			expect(decision).toMatchObject({
				status: "denied",
				code: "provider.exhausted",
				budget: { evaluation: "denied", reservation: "not-created" },
			});
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});

	it("fails closed when evidence verification is unavailable", async () => {
		const ledger = authority();
		try {
			const deps = dependencies(ledger);
			deps.verifyLiability = async () => {
				throw new Error("offline");
			};
			expect(
				await admitIacTarget({ requestId: "offline", ...fixture() }, deps),
			).toMatchObject({
				status: "denied",
				code: "LIABILITY_VERIFIER_UNAVAILABLE",
			});
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});

	it.each([
		"reserve",
		"claimExecution",
	] as const)("reports an uncertain outcome when %s commits but loses its acknowledgement", async (operation) => {
		const ledger = authority();
		try {
			const deps = dependencies(ledger);
			const wrapped = { ...ledger };
			if (operation === "reserve")
				wrapped.reserve = (input) => {
					ledger.reserve(input);
					throw new Error("lost response");
				};
			else
				wrapped.claimExecution = (input) => {
					ledger.claimExecution(input);
					throw new Error("lost response");
				};
			deps.authority = wrapped;
			const decision = await admitIacTarget(
				{ requestId: `lost-${operation}`, ...fixture() },
				deps,
			);
			expect(decision).toMatchObject({
				status: "uncertain",
				budget: { evaluation: "unavailable" },
			});
			expect(ledger.read(NOW).reservedMicros).toBe(1_500_000);
		} finally {
			ledger.close();
		}
	});

	it("claims at most one execution for concurrent identical requests", async () => {
		const ledger = authority();
		try {
			const request = { requestId: "concurrent", ...fixture() };
			const decisions = await Promise.all([
				admitIacTarget(request, dependencies(ledger)),
				admitIacTarget(request, dependencies(ledger)),
			]);
			expect(
				decisions.filter((decision) => decision.status === "admitted"),
			).toHaveLength(1);
			expect(
				decisions.filter((decision) => decision.status !== "admitted")[0]
					?.status,
			).toMatch(/^(replay|uncertain)$/u);
			expect(ledger.read(NOW).reservedMicros).toBe(1_500_000);
		} finally {
			ledger.close();
		}
	});

	it("uses an asynchronous durable authority without authorizing a replay", async () => {
		const ledger = authority();
		try {
			const asyncAuthority = {
				persistence: "durable-cas" as const,
				read: async (at: string) => ledger.read(at),
				lookup: async (id: string) => ledger.lookup(id),
				reserve: async (input: Parameters<typeof ledger.reserve>[0]) =>
					ledger.reserve(input),
				reserveUnbounded: async (
					input: Parameters<typeof ledger.reserveUnbounded>[0],
				) => ledger.reserveUnbounded(input),
				revalidateUnbounded: async (
					input: Parameters<typeof ledger.revalidateUnbounded>[0],
				) => ledger.revalidateUnbounded(input),
				revalidatePriced: async (
					input: Parameters<typeof ledger.revalidatePriced>[0],
				) => ledger.revalidatePriced(input),
				claimExecution: async (
					input: Parameters<typeof ledger.claimExecution>[0],
				) => ledger.claimExecution(input),
				settle: async (...args: Parameters<typeof ledger.settle>) =>
					ledger.settle(...args),
				uncertain: async (id: string) => ledger.uncertain(id),
				release: async (...args: Parameters<typeof ledger.release>) =>
					ledger.release(...args),
			};
			const deps = { ...dependencies(ledger), authority: asyncAuthority };
			const request = { requestId: "async-authority", ...fixture() };
			expect(await admitIacTarget(request, deps)).toMatchObject({
				status: "admitted",
				budget: { evaluation: "allowed", reservation: "held" },
			});
			expect(await admitIacTarget(request, deps)).toMatchObject({
				status: "replay",
				code: "EXECUTION_ALREADY_CLAIMED",
			});
			expect(ledger.read(NOW).reservedMicros).toBe(1_500_000);
		} finally {
			ledger.close();
		}
	});

	it("does not admit when another worker claims between the ledger read and claim", async () => {
		const ledger = authority();
		try {
			const deps = dependencies(ledger);
			const wrapped = { ...ledger };
			wrapped.claimExecution = (input) => {
				ledger.claimExecution(input);
				return ledger.claimExecution(input);
			};
			deps.authority = wrapped;
			const decision = await admitIacTarget(
				{ requestId: "claim-race", ...fixture() },
				deps,
			);
			expect(decision).toMatchObject({
				status: "uncertain",
				code: "EXECUTION_CLAIM_UNCERTAIN",
				budget: { reservation: "held" },
			});
			expect(ledger.lookup("iac:claim-race")?.executionDigest).toMatch(
				/^sha256:/u,
			);
			expect(ledger.read(NOW).reservedMicros).toBe(1_500_000);
		} finally {
			ledger.close();
		}
	});

	it("uses one durable request across target fallback and refuses a later duplicate", async () => {
		const ledger = authority(1_200_000);
		try {
			const first = fixture();
			const second = fixture();
			second.inventory.targetId = "yard-b";
			const repriced = quoteTargetPricing(second.inventory, second.pricing);
			if (!repriced.ok) throw new Error(repriced.reason);
			second.evidence.targetId = "yard-b";
			second.evidence.inventoryHash = repriced.inventoryHash;
			second.evidence.maximumMicros = 1_000_000;
			const account = second.evidence.providerAccounts[0];
			if (account === undefined) throw new Error("fixture account missing");
			account.liabilityMicros = 1_000_000;
			const deps = dependencies(ledger);
			expect(
				await admitIacTarget({ requestId: "shared-route", ...first }, deps),
			).toMatchObject({ status: "denied", code: "provider.exhausted" });
			expect(
				await admitIacTarget({ requestId: "shared-route", ...second }, deps),
			).toMatchObject({ status: "admitted" });
			expect(
				await admitIacTarget({ requestId: "shared-route", ...first }, deps),
			).toMatchObject({
				status: "uncertain",
				code: "RESERVATION_OUTCOME_UNKNOWN",
			});
			expect(
				await admitIacTarget({ requestId: "shared-route", ...second }, deps),
			).toMatchObject({ status: "replay", code: "EXECUTION_ALREADY_CLAIMED" });
			expect(ledger.read(NOW).reservedMicros).toBe(1_000_000);
		} finally {
			ledger.close();
		}
	});
});
