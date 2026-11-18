import { clone, create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ChargeComponentSchema,
	MeterDefinitionSchema,
	ProviderAgreementSchema,
	ProviderProductSchema,
	RateCardSchema,
	UsageMeasurementSchema,
	WorkloadDeltaSchema,
} from "../src/_generated/pricing_pb.js";
import {
	createTargetPricingInventory,
	parseTargetPricingAvailability,
	quoteTargetPricing,
	targetPricingModel,
	targetPricingUnavailable,
} from "../src/target-pricing.js";
import {
	creditState,
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

const digest = `sha256:${"a".repeat(64)}`;

function scenario() {
	return makeScenario({
		charges: [perUnitCharge("runtime", "minute", "0.25")],
		candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
	});
}

function inventory() {
	return createTargetPricingInventory({
		targetId: "target-a",
		tenantId: "tenant-a",
		planDigest: digest,
		complete: true,
		evidenceRef: "inventory:attested",
		resources: [
			{
				resourceId: "stack/compute",
				providerId: "sandbox",
				providerAccountRef: "account-a",
				productId: "sandbox",
			},
		],
	});
}

function modeled() {
	return targetPricingModel({
		modelId: "customer-terms",
		revision: "1",
		planDigest: digest,
		scenario: scenario(),
		bindings: [{ resourceId: "stack/compute", candidateIndex: 0 }],
	});
}

describe("whole-target pricing contract", () => {
	it("preserves unknown pricing instead of producing a zero quote", () => {
		expect(
			quoteTargetPricing(inventory(), targetPricingUnavailable("no model")),
		).toMatchObject({
			ok: false,
			code: "PRICING_MODEL_UNAVAILABLE",
		});
	});

	it("rates one scoped target and pins the developer model", () => {
		const result = quoteTargetPricing(inventory(), modeled());
		expect(result).toMatchObject({
			ok: true,
			source: "developer-supplied",
			modelId: "customer-terms",
			revision: "1",
			quote: { incremental: { billed: { decimal: "1", currency: "USD" } } },
		});
		if (result.ok) expect(result.modelHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
	});

	it("rejects incomplete inventory and an inventory without evidence", () => {
		const partial = inventory();
		partial.complete = false;
		expect(quoteTargetPricing(partial, modeled())).toMatchObject({
			ok: false,
			code: "TARGET_INVENTORY_INCOMPLETE",
		});
		const unattested = inventory();
		unattested.evidenceRef = "";
		expect(quoteTargetPricing(unattested, modeled())).toMatchObject({
			ok: false,
			code: "TARGET_INVENTORY_INCOMPLETE",
		});
	});

	it("rejects an unknown IaC operation", () => {
		const target = inventory();
		target.operation = "unexpected";
		expect(quoteTargetPricing(target, modeled())).toMatchObject({
			ok: false,
			code: "TARGET_INVENTORY_INCOMPLETE",
		});
	});

	it("rejects model, account, provider, product and tenant scope mismatches", () => {
		const foreignPlan = modeled();
		if (foreignPlan.state.case !== "model")
			throw new Error("fixture model missing");
		foreignPlan.state.value.planDigest = `sha256:${"b".repeat(64)}`;
		expect(quoteTargetPricing(inventory(), foreignPlan)).toMatchObject({
			ok: false,
			code: "PRICING_MODEL_SCOPE_MISMATCH",
		});
		for (const [field, value] of [
			["providerId", "other"],
			["providerAccountRef", "other"],
			["productId", "other"],
		] as const) {
			const target = inventory();
			const resource = target.resources[0];
			if (resource === undefined) throw new Error("fixture resource missing");
			resource[field] = value;
			expect(quoteTargetPricing(target, modeled()), field).toMatchObject({
				ok: false,
				code: "PRICING_MODEL_SCOPE_MISMATCH",
			});
		}
		const foreignTenant = inventory();
		foreignTenant.tenantId = "other";
		expect(quoteTargetPricing(foreignTenant, modeled())).toMatchObject({
			ok: false,
			code: "PRICING_MODEL_SCOPE_MISMATCH",
		});
	});

	it("refuses missing, extra and duplicate resource bindings", () => {
		const missing = modeled();
		if (missing.state.case !== "model")
			throw new Error("fixture model missing");
		missing.state.value.bindings = [];
		expect(quoteTargetPricing(inventory(), missing)).toMatchObject({
			ok: false,
			code: "TARGET_PRICING_INCOMPLETE",
		});
		const duplicate = modeled();
		if (duplicate.state.case !== "model")
			throw new Error("fixture model missing");
		const binding = duplicate.state.value.bindings[0];
		if (binding === undefined) throw new Error("fixture binding missing");
		duplicate.state.value.bindings.push(binding);
		expect(quoteTargetPricing(inventory(), duplicate)).toMatchObject({
			ok: false,
			code: "TARGET_PRICING_INCOMPLETE",
		});
		const extra = inventory();
		const resource = extra.resources[0];
		if (resource === undefined) throw new Error("fixture resource missing");
		extra.resources.push({ ...resource, resourceId: "stack/database" });
		expect(quoteTargetPricing(extra, modeled())).toMatchObject({
			ok: false,
			code: "TARGET_PRICING_INCOMPLETE",
		});
	});

	it("prices all resources together so a shared credit is consumed once", () => {
		const joint = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "1")],
			candidate: [
				workload("agreement-a", [usage("minute", "6", "minute")]),
				workload("agreement-a", [usage("minute", "6", "minute")]),
			],
			credits: [creditState("shared", "zero", 0)],
		});
		const target = inventory();
		const resource = target.resources[0];
		if (resource === undefined) throw new Error("fixture resource missing");
		target.resources.push({ ...resource, resourceId: "stack/worker" });
		const model = targetPricingModel({
			modelId: "joint",
			revision: "1",
			planDigest: digest,
			scenario: joint,
			bindings: [
				{ resourceId: "stack/compute", candidateIndex: 0 },
				{ resourceId: "stack/worker", candidateIndex: 1 },
			],
		});
		expect(quoteTargetPricing(target, model)).toMatchObject({
			ok: true,
			quote: { incremental: { billed: { decimal: "2", currency: "USD" } } },
		});
	});

	it("rejects incomplete rate cards on baseline-only products", () => {
		const model = modeled();
		if (
			model.state.case !== "model" ||
			model.state.value.scenario === undefined
		) {
			throw new Error("fixture model missing");
		}
		const joint = model.state.value.scenario;
		const catalog = joint.catalog;
		const state = joint.state;
		const sourceCard = catalog?.rateCards[0];
		const sourceAgreement = state?.agreements[0];
		const candidate = joint.candidate[0];
		if (
			catalog === undefined ||
			state === undefined ||
			sourceCard === undefined ||
			sourceAgreement === undefined ||
			candidate === undefined
		) {
			throw new Error("fixture scenario incomplete");
		}
		const sandboxProduct = catalog.products[0];
		if (sandboxProduct === undefined)
			throw new Error("fixture product missing");
		const databaseProduct = clone(ProviderProductSchema, sandboxProduct);
		databaseProduct.id = "database";
		databaseProduct.meters = [
			create(MeterDefinitionSchema, {
				dimension: "gb",
				unit: "gb",
				aggregation: "sum",
			}),
		];
		catalog.products.push(databaseProduct);
		const dbCard = clone(RateCardSchema, sourceCard);
		dbCard.id = "card-db";
		dbCard.charges = [
			create(ChargeComponentSchema, {
				base: {
					id: "storage",
					selectors: {},
					fallback: false,
					invoiceBehavior: "itemized",
				},
				variant: {
					case: "usage",
					value: {
						dimension: "unmodeled",
						timing: "arrears",
						price: {
							case: "perUnit",
							value: { decimal: "0.10", currency: "USD" },
						},
					},
				},
			}),
		];
		catalog.rateCards.push(dbCard);
		const dbAgreement = clone(ProviderAgreementSchema, sourceAgreement);
		dbAgreement.id = "agreement-db";
		dbAgreement.productId = "database";
		for (const entry of dbAgreement.rateSchedule) entry.rateCardId = "card-db";
		state.agreements.push(dbAgreement);
		const baseline = clone(WorkloadDeltaSchema, candidate);
		baseline.productRef = "database";
		baseline.agreementRef = "agreement-db";
		const measurement = candidate.usage[0];
		if (measurement === undefined)
			throw new Error("fixture measurement missing");
		const gbUsage = clone(UsageMeasurementSchema, measurement);
		gbUsage.dimension = "gb";
		gbUsage.quantity = { decimal: "10", unit: "gb" };
		baseline.usage = [gbUsage];
		joint.baseline.push(baseline);
		rehashScenario(joint);
		expect(quoteTargetPricing(inventory(), model).ok).toBe(false);
	});

	it("rejects an active agreement outside the inventory when its fixed quantity is missing", () => {
		const model = modeled();
		if (
			model.state.case !== "model" ||
			model.state.value.scenario === undefined
		) {
			throw new Error("fixture model missing");
		}
		const joint = model.state.value.scenario;
		const catalog = joint.catalog;
		const state = joint.state;
		const sourceCard = catalog?.rateCards[0];
		const sourceAgreement = state?.agreements[0];
		const sandboxProduct = catalog?.products[0];
		if (
			catalog === undefined ||
			state === undefined ||
			sourceCard === undefined ||
			sourceAgreement === undefined ||
			sandboxProduct === undefined
		) {
			throw new Error("fixture scenario incomplete");
		}
		const support = clone(ProviderProductSchema, sandboxProduct);
		support.id = "support";
		support.meters = [];
		catalog.products.push(support);
		const supportCard = clone(RateCardSchema, sourceCard);
		supportCard.id = "card-support";
		supportCard.charges = [
			create(ChargeComponentSchema, {
				base: {
					id: "seat",
					selectors: {},
					fallback: false,
					invoiceBehavior: "itemized",
				},
				variant: {
					case: "fixed",
					value: {
						cadence: "monthly",
						timing: "advance",
						amount: { decimal: "10", currency: "USD" },
						quantityDimension: "seat",
						proration: "none",
					},
				},
			}),
		];
		catalog.rateCards.push(supportCard);
		const supportAgreement = clone(ProviderAgreementSchema, sourceAgreement);
		supportAgreement.id = "agreement-support";
		supportAgreement.productId = "support";
		for (const entry of supportAgreement.rateSchedule)
			entry.rateCardId = "card-support";
		state.agreements.push(supportAgreement);
		rehashScenario(joint);
		expect(quoteTargetPricing(inventory(), model)).toMatchObject({
			ok: false,
			code: "TARGET_PRICING_INCOMPLETE",
		});
	});

	it("requires complete measurements for baseline workloads as well as candidates", () => {
		const model = modeled();
		if (
			model.state.case !== "model" ||
			model.state.value.scenario === undefined
		)
			throw new Error("fixture model missing");
		const original = model.state.value.scenario.candidate[0];
		if (original === undefined) throw new Error("fixture candidate missing");
		model.state.value.scenario.baseline.push({ ...original, usage: [] });
		expect(quoteTargetPricing(inventory(), model)).toMatchObject({
			ok: false,
			code: "TARGET_PRICING_INCOMPLETE",
		});
	});

	it("bounds untrusted models before parsing or rating", () => {
		const model = modeled();
		if (
			model.state.case !== "model" ||
			model.state.value.scenario === undefined
		)
			throw new Error("fixture model missing");
		const candidate = model.state.value.scenario.candidate[0];
		if (candidate === undefined) throw new Error("fixture candidate missing");
		const measurement = candidate.usage[0];
		if (measurement === undefined)
			throw new Error("fixture measurement missing");
		candidate.usage = Array.from({ length: 1025 }, () => measurement);
		expect(quoteTargetPricing(inventory(), model)).toMatchObject({
			ok: false,
			code: "PRICING_INPUT_TOO_LARGE",
		});
		expect(
			parseTargetPricingAvailability({
				model: { bindings: Array.from({ length: 1025 }, () => ({})) },
			}),
		).toBeUndefined();
	});
});
