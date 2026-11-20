import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { TieredPriceSchema } from "../src/_generated/pricing_pb.js";
import { quoteScenarioV2 } from "../src/quote.js";
import {
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

type Mode = "graduated" | "volume";
type Boundary = { from: string; to?: string; price: string };

function scenario(mode: Mode, bounds: readonly Boundary[], quantity = "4") {
	const input = makeScenario({
		charges: [perUnitCharge("runtime", "minute", "1")],
		candidate: [workload("agreement-a", [usage("minute", quantity, "minute")])],
	});
	const charge = input.catalog?.rateCards[0]?.charges[0];
	if (charge?.variant.case !== "usage")
		throw new Error("missing charge fixture");
	const tiers = create(TieredPriceSchema, {
		tiers: bounds.map(({ from, to, price }) => {
			const tier = {
				from,
				flatAmount: { decimal: "0", currency: "USD" },
				unitAmount: { decimal: price, currency: "USD" },
			};
			return to === undefined ? tier : { ...tier, to };
		}),
	});
	charge.variant.value.price =
		mode === "graduated"
			? { case: "graduated", value: tiers }
			: { case: "volume", value: tiers };
	rehashScenario(input);
	return input;
}

describe("tier coverage", () => {
	it.each([
		"graduated",
		"volume",
	] as const)("rejects malformed %s tier intervals", (mode) => {
		const malformed: readonly (readonly Boundary[])[] = [
			[{ from: "1", price: "1" }],
			[
				{ from: "0", to: "2", price: "1" },
				{ from: "3", price: "2" },
			],
			[
				{ from: "0", to: "4", price: "1" },
				{ from: "3", price: "2" },
			],
			[
				{ from: "0", price: "1" },
				{ from: "0", price: "2" },
			],
			[{ from: "0", to: "0", price: "1" }],
			[{ from: "0", to: "-1", price: "1" }],
			[{ from: "-1", price: "1" }],
		];
		for (const bounds of malformed)
			expect(quoteScenarioV2(scenario(mode, bounds))).toMatchObject({
				code: "INVALID_PRICING_INPUT",
			});
	});

	it.each([
		"graduated",
		"volume",
	] as const)("rejects %s usage beyond a finite last tier", (mode) => {
		expect(
			quoteScenarioV2(
				scenario(mode, [
					{ from: "0", to: "2", price: "1" },
					{ from: "2", to: "3", price: "2" },
				]),
			),
		).toMatchObject({ code: "RATE_CARD_NOT_FOUND" });
	});

	it.each([
		["graduated", "6"],
		["volume", "8"],
	] as const)("rates contiguous %s tiers regardless of input order", (mode, expected) => {
		for (const bounds of [
			[
				{ from: "0", to: "2", price: "1" },
				{ from: "2", price: "2" },
			],
			[
				{ from: "2", price: "2" },
				{ from: "0", to: "2", price: "1" },
			],
			[
				{ from: "0", price: "1" },
				{ from: "2", price: "2" },
			],
		])
			expect(quoteScenarioV2(scenario(mode, bounds))).toMatchObject({
				$typeName: "hobo.pricing.v1.QuoteVector",
				incremental: { billed: { decimal: expected, currency: "USD" } },
			});
	});

	it.each([
		["graduated", "4"],
		["volume", "6"],
	] as const)("rates %s usage inside a finite final tier", (mode, expected) => {
		expect(
			quoteScenarioV2(
				scenario(
					mode,
					[
						{ from: "0", to: "2", price: "1" },
						{ from: "2", to: "4", price: "2" },
					],
					"3",
				),
			),
		).toMatchObject({
			$typeName: "hobo.pricing.v1.QuoteVector",
			incremental: { billed: { decimal: expected, currency: "USD" } },
		});
	});

	it("treats the finite final boundary as inclusive for graduated and exclusive for volume", () => {
		const bounds = [
			{ from: "0", to: "2", price: "1" },
			{ from: "2", to: "4", price: "2" },
		];
		expect(quoteScenarioV2(scenario("graduated", bounds))).toMatchObject({
			$typeName: "hobo.pricing.v1.QuoteVector",
			incremental: { billed: { decimal: "6", currency: "USD" } },
		});
		expect(quoteScenarioV2(scenario("volume", bounds))).toMatchObject({
			code: "RATE_CARD_NOT_FOUND",
		});
	});
});
