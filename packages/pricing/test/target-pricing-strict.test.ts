import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { TargetPricingBindingSchema } from "../src/_generated/pricing_pb.js";
import {
	createTargetPricingInventory,
	quoteTargetPricing,
	targetPricingModel,
	targetPricingUnavailable,
} from "../src/target-pricing.js";
import { makeScenario, perUnitCharge, usage, workload } from "./fixtures.js";

const digest = `sha256:${"a".repeat(64)}`;
function fixture() {
	const scenario = makeScenario({
		charges: [perUnitCharge("runtime", "minute", "0.25")],
		candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
	});
	const input = {
		modelId: "terms",
		revision: "1",
		planDigest: digest,
		scenario,
		bindings: [{ resourceId: "r", candidateIndex: 0 }],
	};
	const inventory = createTargetPricingInventory({
		targetId: "yard",
		tenantId: "tenant-a",
		planDigest: digest,
		complete: true,
		evidenceRef: "inventory:1",
		resources: [
			{
				resourceId: "r",
				providerId: "sandbox",
				providerAccountRef: "account-a",
				productId: "sandbox",
			},
		],
	});
	return { scenario, input, inventory };
}

describe("strict developer target pricing data", () => {
	it.each([
		"surcharge",
		"length",
		"undefined",
		"array-property",
		"sparse-array",
		"wrapper-metadata",
	])("rejects unsupported nested %s before it can disappear", (kind) => {
		const { scenario, input, inventory } = fixture();
		const charges = scenario.catalog?.rateCards[0]?.charges;
		const charge = charges?.[0];
		if (!charges || !charge) throw new Error("fixture charge missing");
		if (kind === "surcharge")
			Object.defineProperty(charge, "surcharge", {
				value: { amount: "100", currency: "USD" },
				enumerable: true,
			});
		if (kind === "length")
			Object.defineProperty(charge, "length", { value: 100, enumerable: true });
		if (kind === "undefined")
			Object.defineProperty(charge, "unknown", {
				value: undefined,
				enumerable: true,
			});
		if (kind === "array-property")
			Object.defineProperty(charges, "extra", {
				value: "additional-charge",
				enumerable: true,
			});
		if (kind === "sparse-array") charges.length = 2;
		if (kind === "wrapper-metadata")
			Object.defineProperty(charge.variant, "$unknown", {
				value: [],
				enumerable: true,
			});
		expect(() => targetPricingModel(input)).toThrow();
		const valid = fixture();
		const availability = targetPricingModel(valid.input);
		if (
			availability.state.case !== "model" ||
			!availability.state.value.scenario
		)
			throw new Error("model missing");
		availability.state.value.scenario = scenario;
		expect(quoteTargetPricing(inventory, availability)).toMatchObject({
			ok: false,
			code:
				kind === "array-property" || kind === "sparse-array"
					? "PRICING_INPUT_TOO_LARGE"
					: "PRICING_MODEL_INVALID",
		});
	});

	it("fails closed if an explicitly undefined optional field would disappear", () => {
		const { scenario, input } = fixture();
		const effective = scenario.catalog?.rateCards[0]?.effective;
		if (!effective) throw new Error("fixture interval missing");
		effective.end = undefined;
		expect(() => targetPricingModel(input)).toThrow();
	});

	it("does not turn malformed unavailable data into unpriced permission", () => {
		const { inventory } = fixture();
		const unavailable = targetPricingUnavailable("no model");
		if (unavailable.state.case !== "unavailable")
			throw new Error("unavailable missing");
		Object.defineProperty(unavailable.state.value, "unmodeledCharge", {
			value: "100",
			enumerable: true,
		});
		expect(quoteTargetPricing(inventory, unavailable)).toMatchObject({
			ok: false,
			code: "PRICING_MODEL_INVALID",
		});
	});

	it("rejects accessors, exotic prototypes, cycles and oversized raw scenarios without invoking getters", () => {
		for (const kind of [
			"accessor",
			"prototype",
			"cycle",
			"oversized",
		] as const) {
			const { scenario, input } = fixture();
			let called = false;
			if (kind === "accessor")
				Object.defineProperty(scenario, "extra", {
					enumerable: true,
					get: () => {
						called = true;
						return "x";
					},
				});
			if (kind === "prototype")
				Object.setPrototypeOf(scenario, { unsupported: true });
			if (kind === "cycle")
				Object.defineProperty(scenario, "extra", {
					enumerable: true,
					value: scenario,
				});
			if (kind === "oversized")
				scenario.candidate = Array.from(
					{ length: 1025 },
					() => scenario.candidate[0]!,
				);
			expect(() => targetPricingModel(input), kind).toThrow();
			expect(called, kind).toBe(false);
		}
	});

	it("retains valid generated message metadata and rejects unknown wire data", () => {
		const { scenario, input, inventory } = fixture();
		Object.defineProperty(scenario, "$unknown", {
			value: [],
			enumerable: true,
		});
		const binding = create(TargetPricingBindingSchema, {
			resourceId: "r",
			candidateIndex: 0,
		});
		const availability = targetPricingModel({ ...input, bindings: [binding] });
		if (
			availability.state.case !== "model" ||
			!availability.state.value.scenario
		)
			throw new Error("model missing");
		expect(availability.state.value.scenario.$typeName).toBe(
			"hobo.pricing.v1.QuoteScenario",
		);
		expect(availability.state.value.bindings[0]?.$typeName).toBe(
			"hobo.pricing.v1.TargetPricingBinding",
		);
		expect(quoteTargetPricing(inventory, availability)).toMatchObject({
			ok: true,
		});
		const other = fixture();
		Object.defineProperty(other.scenario, "$unknown", {
			value: [{ no: 999, wireType: 0, data: new Uint8Array([1]) }],
			enumerable: true,
		});
		expect(() => targetPricingModel(other.input)).toThrow();
	});
});
