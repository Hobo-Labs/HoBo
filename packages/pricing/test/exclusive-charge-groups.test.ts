import { describe, expect, it } from "vitest";
import { quoteScenario } from "../src/quote.js";
import {
	fixedCharge,
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

function regional(withFallback: boolean, region: string) {
	const charges = [
		perUnitCharge("base", "minute", "1"),
		perUnitCharge("east", "minute", "100"),
	];
	if (withFallback) charges.push(perUnitCharge("fallback", "minute", "3"));
	const input = makeScenario({
		charges,
		candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
	});
	const items = input.catalog?.rateCards[0]?.charges;
	const east = items?.[1]?.base;
	const candidate = input.candidate[0];
	if (!items || !east || !candidate) throw new Error("missing group fixture");
	east.exclusiveGroup = "region";
	east.selectors = { region: "east" };
	if (withFallback) {
		const fallback = items[2]?.base;
		if (!fallback) throw new Error("missing fallback fixture");
		fallback.exclusiveGroup = "region";
		fallback.fallback = true;
	}
	candidate.attributes = { region };
	rehashScenario(input);
	return input;
}

describe("exclusive charge groups", () => {
	it("refuses an unmatched group even when an independent charge would otherwise price the meter", () => {
		expect(quoteScenario(regional(false, "west"))).toMatchObject({
			code: "MISSING_EXCLUSIVE_FALLBACK",
		});
	});

	it.each([
		["west", "16"],
		["east", "404"],
	] as const)("selects the one applicable group charge for %s", (region, expected) => {
		expect(quoteScenario(regional(true, region))).toMatchObject({
			$typeName: "hobo.pricing.v1.QuoteVector",
			incremental: { billed: { decimal: expected, currency: "USD" } },
		});
	});

	it.each([
		"mixed-variant",
		"mixed-dimension",
	] as const)("rejects %s alternatives that cannot be selected as one group", (kind) => {
		const input =
			kind === "mixed-variant"
				? makeScenario({
						charges: [
							perUnitCharge("usage", "minute", "1"),
							fixedCharge("fixed", "10"),
						],
						candidate: [
							workload("agreement-a", [usage("minute", "4", "minute")]),
						],
					})
				: makeScenario({
						charges: [
							perUnitCharge("usage", "minute", "1"),
							perUnitCharge("second", "request", "1"),
						],
						meters: [
							{ dimension: "minute", unit: "minute", aggregation: "sum" },
							{ dimension: "request", unit: "request", aggregation: "sum" },
						],
						candidate: [
							workload("agreement-a", [
								usage("minute", "4", "minute"),
								usage("request", "2", "request"),
							]),
						],
					});
		const charges = input.catalog?.rateCards[0]?.charges;
		if (!charges?.[0]?.base || !charges[1]?.base)
			throw new Error("missing group fixture");
		charges[0].base.exclusiveGroup = "plan";
		charges[1].base.exclusiveGroup = "plan";
		rehashScenario(input);
		expect(quoteScenario(input)).toMatchObject({
			code: "PRICING_MODEL_UNSUPPORTED",
		});
	});

	it("rejects a fallback charge without an exclusive group", () => {
		const input = regional(true, "west");
		const fallback = input.catalog?.rateCards[0]?.charges[2]?.base;
		if (!fallback) throw new Error("missing fallback fixture");
		Reflect.deleteProperty(fallback, "exclusiveGroup");
		rehashScenario(input);
		expect(quoteScenario(input)).toMatchObject({
			code: "INVALID_PRICING_INPUT",
		});
	});
});
