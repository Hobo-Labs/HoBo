import { describe, expect, it } from "vitest";
import {
	createTargetPricingInventory,
	hashTargetPricingInventory,
	parseTargetPricingAvailability,
	quoteTargetPricing,
	targetPricingModel,
	targetPricingUnavailable,
} from "../src/target-pricing.js";
import {
	creditState,
	makeScenario,
	perUnitCharge,
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
	it("hashes complete inventories without requiring a price and refuses incomplete scopes", () => {
		const target = inventory();
		const quoted = quoteTargetPricing(target, modeled());
		const hash = hashTargetPricingInventory(target);
		expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
		if (!quoted.ok) throw new Error(quoted.reason);
		expect(hash).toBe(quoted.inventoryHash);
		target.complete = false;
		expect(hashTargetPricingInventory(target)).toBeUndefined();
	});

	it("does not hash an inventory after dropping unknown resource or scope data", () => {
		for (const location of ["inventory", "resource"] as const) {
			const target = inventory();
			const altered = location === "inventory" ? target : target.resources[0];
			if (altered === undefined) throw new Error("fixture resource missing");
			Object.defineProperty(altered, "unmodeledCharge", {
				value: "100",
				enumerable: true,
			});
			expect(hashTargetPricingInventory(target), location).toBeUndefined();
		}
	});
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
