import { describe, expect, it } from "vitest";
import { quoteScenarioV2 } from "../src/quote.js";
import {
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

function scenario(scope?: string, multiple = "1", mode = "ceil") {
	const plainMeter = {
		dimension: "users",
		unit: "user",
		aggregation: "unique-count",
	};
	const meter =
		scope === undefined
			? plainMeter
			: { ...plainMeter, rounding: { scope, multiple, mode } };
	return makeScenario({
		charges: [perUnitCharge("active-users", "users", "1")],
		meters: [meter],
		candidate: [
			workload("agreement-a", [usage("users", "3", "user", ["a", "b", "c"])]),
		],
	});
}

describe("unique-count meter rounding", () => {
	it.each([
		["ceil", "5"],
		["floor", "0"],
	] as const)("applies period %s rounding after unique aggregation", (mode, expected) => {
		expect(quoteScenarioV2(scenario("period", "5", mode))).toMatchObject({
			$typeName: "hobo.pricing.v1.QuoteVector",
			incremental: { billed: { decimal: expected, currency: "USD" } },
		});
	});

	it("rejects nontrivial event rounding rather than rounding an aggregate", () => {
		expect(quoteScenarioV2(scenario("event", "5"))).toMatchObject({
			code: "PRICING_MODEL_UNSUPPORTED",
		});
	});

	it.each([
		"event",
		"period",
	])("allows identity rounding at %s scope", (scope) => {
		expect(quoteScenarioV2(scenario(scope, "1"))).toMatchObject({
			$typeName: "hobo.pricing.v1.QuoteVector",
			incremental: { billed: { decimal: "3", currency: "USD" } },
		});
	});

	it("rejects removal where shared unique values have no source multiplicity", () => {
		const input = scenario();
		const removed = input.candidate[0];
		if (!removed) throw new Error("missing workload fixture");
		input.baseline.push({ ...removed, usage: [...removed.usage] });
		removed.direction = "remove";
		expect(quoteScenarioV2(input)).toMatchObject({
			code: "PRICING_MODEL_UNSUPPORTED",
		});
	});

	it("rejects invalid rounding instead of silently ignoring it", () => {
		const input = scenario("period", "0");
		rehashScenario(input);
		expect(quoteScenarioV2(input)).toMatchObject({
			code: "INVALID_PRICING_INPUT",
		});
	});
});
