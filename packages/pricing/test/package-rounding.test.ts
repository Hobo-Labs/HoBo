import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { PackagePriceSchema } from "../src/_generated/pricing_pb.js";
import { quoteScenario } from "../src/quote.js";
import {
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

function scenario(quantities: readonly string[]) {
	const input = makeScenario({
		charges: [perUnitCharge("runtime", "minute", "1")],
		candidate: [
			workload(
				"agreement-a",
				quantities.map((amount) => usage("minute", amount, "minute")),
			),
		],
	});
	const charge = input.catalog?.rateCards[0]?.charges[0];
	if (charge?.variant.case !== "usage")
		throw new Error("missing charge fixture");
	const price = create(PackagePriceSchema, {
		packageSize: "10",
		packageAmount: { decimal: "7", currency: "USD" },
		rounding: { scope: "period", multiple: "1", mode: "ceil" },
	});
	charge.variant.value.price = { case: "package", value: price };
	return { input, price };
}

describe("package rounding", () => {
	it.each([
		"event",
		"multiple",
		"unknown-scope",
		"unknown-mode",
		"missing-rounding",
	] as const)("rejects unsupported package rounding %s rather than approximating it", (kind) => {
		const { input, price } = scenario(["1", "1"]);
		if (!price.rounding) throw new Error("missing rounding fixture");
		if (kind === "event") price.rounding.scope = "event";
		if (kind === "multiple") price.rounding.multiple = "2";
		if (kind === "unknown-scope") price.rounding.scope = "unknown";
		if (kind === "unknown-mode") price.rounding.mode = "unknown";
		if (kind === "missing-rounding") Reflect.deleteProperty(price, "rounding");
		rehashScenario(input);
		expect(quoteScenario(input)).toMatchObject({
			code: "PRICING_MODEL_UNSUPPORTED",
		});
	});

	it.each([
		["ceil", "11", "14"],
		["floor", "11", "7"],
		["half-up", "15", "14"],
	] as const)("prices supported period %s rounding", (mode, quantity, expected) => {
		const { input, price } = scenario([quantity]);
		if (!price.rounding) throw new Error("missing rounding fixture");
		price.rounding.mode = mode;
		price.rounding.multiple = "1.0";
		rehashScenario(input);
		expect(quoteScenario(input)).toMatchObject({
			$typeName: "hobo.pricing.v1.QuoteVector",
			incremental: { billed: { decimal: expected, currency: "USD" } },
		});
	});

	it.each([
		"0",
		"-1",
		"invalid",
		"1e3",
	])("rejects invalid package size %s", (size) => {
		const { input, price } = scenario(["1"]);
		price.packageSize = size;
		rehashScenario(input);
		expect(quoteScenario(input)).toMatchObject({
			code: "INVALID_PRICING_INPUT",
		});
	});

	it("allows an explicit zero-priced package", () => {
		const { input, price } = scenario(["11"]);
		if (!price.packageAmount) throw new Error("missing package amount fixture");
		price.packageAmount.decimal = "0";
		rehashScenario(input);
		expect(quoteScenario(input)).toMatchObject({
			$typeName: "hobo.pricing.v1.QuoteVector",
			incremental: { billed: { decimal: "0", currency: "USD" } },
		});
	});
});
