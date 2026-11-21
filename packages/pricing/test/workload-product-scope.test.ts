import { describe, expect, it } from "vitest";
import { quoteScenario } from "../src/quote.js";
import {
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

describe("workload product scope", () => {
	it.each([
		["candidate", false],
		["candidate", true],
		["baseline", false],
		["baseline", true],
	] as const)("rejects a %s workload whose product differs from its agreement (product exists=%s)", (snapshot, productExists) => {
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "1")],
			candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
		});
		const first = scenario.candidate[0];
		const product = scenario.catalog?.products[0];
		if (!first || !product || !scenario.catalog)
			throw new Error("missing fixture inputs");
		if (productExists)
			scenario.catalog.products.push({ ...product, id: "other" });
		if (snapshot === "candidate") first.productRef = "other";
		else scenario.baseline.push({ ...first, productRef: "other" });
		rehashScenario(scenario);
		const result = quoteScenario(scenario);
		expect(result.$typeName).toBe("hobo.pricing.v1.PricingRejected");
		if (result.$typeName !== "hobo.pricing.v1.PricingRejected")
			throw new Error("expected a rejected quote");
		expect(result.code).toBe("INVALID_PRICING_INPUT");
	});

	it("continues to rate a product against its own agreement", () => {
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "1")],
			candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
		});
		expect(quoteScenario(scenario)).toMatchObject({
			$typeName: "hobo.pricing.v1.QuoteVector",
			incremental: { billed: { decimal: "4", currency: "USD" } },
		});
	});
});
