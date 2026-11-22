import { describe, expect, it } from "vitest";
import {
	developerPricing,
	quoteAvailablePricing,
} from "../src/availability.js";
import { quoteScenario } from "../src/quote.js";
import {
	createTargetPricingInventory,
	quoteTargetPricing,
	targetPricingModel,
} from "../src/target-pricing.js";
import {
	fixedCharge,
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

const digest = `sha256:${"a".repeat(64)}`;
const scope = {
	modelId: "terms",
	revision: "1",
	tenantId: "tenant-a",
	providerId: "sandbox",
	providerAccountRef: "account-a",
	productId: "sandbox",
};

function makeQuote(scenario: ReturnType<typeof makeScenario>) {
	const inventory = createTargetPricingInventory({
		targetId: "target-a",
		tenantId: "tenant-a",
		planDigest: digest,
		complete: true,
		evidenceRef: "inventory:1",
		resources: [
			{
				resourceId: "service",
				providerId: "sandbox",
				providerAccountRef: "account-a",
				productId: "sandbox",
			},
		],
	});
	const pricing = targetPricingModel({
		modelId: "terms",
		revision: "1",
		planDigest: digest,
		scenario,
		bindings: [{ resourceId: "service", candidateIndex: 0 }],
	});
	return quoteTargetPricing(inventory, pricing);
}

describe("rate-card charge integrity", () => {
	it.each([
		"missing-usage-base",
		"missing-fixed-base",
		"empty-id",
		"duplicate-id",
		"unset-variant",
		"empty-card",
	] as const)("rejects %s before a developer model can be ranked", (kind) => {
		const scenario = makeScenario({
			charges: [
				perUnitCharge("runtime", "minute", "1"),
				fixedCharge("subscription", "10"),
			],
			candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
		});
		const charges = scenario.catalog?.rateCards[0]?.charges;
		const first = charges?.[0];
		const second = charges?.[1];
		if (!charges || !first?.base || !second?.base)
			throw new Error("missing charge fixture");
		const firstBase = first.base;
		const secondBase = second.base;
		if (kind === "missing-usage-base") Reflect.deleteProperty(first, "base");
		if (kind === "missing-fixed-base") Reflect.deleteProperty(second, "base");
		if (kind === "empty-id") firstBase.id = "";
		if (kind === "duplicate-id") secondBase.id = firstBase.id;
		if (kind === "unset-variant") second.variant = { case: undefined };
		if (kind === "empty-card") charges.length = 0;
		rehashScenario(scenario);
		expect(quoteScenario(scenario)).toMatchObject({
			code: "INVALID_PRICING_INPUT",
		});
		expect(makeQuote(scenario)).toMatchObject({
			ok: false,
			code: "INVALID_PRICING_INPUT",
		});
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, scenario)),
		).toMatchObject({ ok: false, code: "INVALID_PRICING_INPUT" });
	});

	it("continues to accept an explicitly modeled zero-price charge", () => {
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "0")],
			candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
		});
		expect(makeQuote(scenario)).toMatchObject({
			ok: true,
			quote: { incremental: { billed: { decimal: "0", currency: "USD" } } },
		});
	});
});
