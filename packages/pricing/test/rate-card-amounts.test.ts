import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	PackagePriceSchema,
	TieredPriceSchema,
} from "../src/_generated/pricing_pb.js";
import {
	developerPricing,
	quoteAvailablePricing,
} from "../src/availability.js";
import { quoteScenario } from "../src/quote.js";
import {
	fixedCharge,
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

const scope = {
	modelId: "terms",
	revision: "1",
	tenantId: "tenant-a",
	providerId: "sandbox",
	providerAccountRef: "account-a",
	productId: "sandbox",
};

describe("declared charge amounts", () => {
	it.each([
		"negative-fixed",
		"negative-per-unit",
		"negative-package",
		"negative-graduated-flat",
		"negative-graduated-unit",
		"negative-volume-flat",
		"negative-volume-unit",
		"wrong-currency",
		"missing-usage-price",
		"negative-unselected",
	] as const)("rejects %s even when the total could remain nonnegative", (kind) => {
		const scenario = makeScenario({
			charges: [
				perUnitCharge("runtime", "minute", "1"),
				fixedCharge("subscription", "20"),
			],
			candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
		});
		const usageCharge = scenario.catalog?.rateCards[0]?.charges[0];
		const fixed = scenario.catalog?.rateCards[0]?.charges[1];
		if (
			usageCharge?.variant.case !== "usage" ||
			fixed?.variant.case !== "fixed" ||
			!fixed.variant.value.amount
		)
			throw new Error("missing charge fixture");
		const price = usageCharge.variant.value.price;
		if (price.case !== "perUnit") throw new Error("missing price fixture");
		if (kind === "negative-fixed") fixed.variant.value.amount.decimal = "-2";
		if (kind === "negative-unselected") {
			fixed.variant.value.amount.decimal = "-2";
			if (!fixed.base) throw new Error("missing charge base fixture");
			fixed.base.selectors = { region: "not-selected" };
		}
		if (kind === "negative-per-unit") price.value.decimal = "-1";
		if (kind === "wrong-currency") price.value.currency = "EUR";
		if (kind === "missing-usage-price")
			usageCharge.variant.value.price = { case: undefined };
		if (kind === "negative-package")
			usageCharge.variant.value.price = {
				case: "package",
				value: create(PackagePriceSchema, {
					packageSize: "1",
					packageAmount: { decimal: "-1", currency: "USD" },
					rounding: { scope: "event", mode: "ceil", multiple: "1" },
				}),
			};
		if (
			kind.startsWith("negative-graduated") ||
			kind.startsWith("negative-volume")
		) {
			const tiers = create(TieredPriceSchema, {
				tiers: [
					{
						from: "0",
						flatAmount: {
							decimal: kind.endsWith("flat") ? "-1" : "0",
							currency: "USD",
						},
						unitAmount: {
							decimal: kind.endsWith("unit") ? "-1" : "1",
							currency: "USD",
						},
					},
				],
			});
			usageCharge.variant.value.price = kind.startsWith("negative-graduated")
				? { case: "graduated", value: tiers }
				: { case: "volume", value: tiers };
		}
		rehashScenario(scenario);
		expect(quoteScenario(scenario)).toMatchObject({
			code: "INVALID_PRICING_INPUT",
		});
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, scenario)),
		).toMatchObject({ ok: false, code: "INVALID_PRICING_INPUT" });
	});
});
