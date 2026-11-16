import { clone } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { ChargeComponentSchema } from "../src/_generated/pricing_pb.js";
import {
	developerPricing,
	parsePricingAvailability,
	pricingUnavailable,
	quoteAvailablePricing,
} from "../src/availability.js";
import {
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

const scope = {
	modelId: "contract-a",
	revision: "1",
	tenantId: "tenant-a",
	providerId: "sandbox",
	providerAccountRef: "account-a",
	productId: "sandbox",
};

function scenario(price = "0.25") {
	return makeScenario({
		charges: [perUnitCharge("runtime", "minute", price)],
		candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
	});
}

describe("declared pricing availability", () => {
	it("parses the wire discriminator and rejects malformed or ambiguous input", () => {
		expect(
			parsePricingAvailability({ unavailable: { reason: "not known" } })?.state
				.case,
		).toBe("unavailable");
		expect(
			parsePricingAvailability({
				unavailable: { reason: "not known" },
				developerModel: {},
			}),
		).toBeUndefined();
		expect(
			parsePricingAvailability({ unavailable: { reason: 123 } }),
		).toBeUndefined();
	});
	it("distinguishes unavailable pricing from a genuinely zero quote", () => {
		expect(
			quoteAvailablePricing("sandbox", pricingUnavailable("no model")),
		).toMatchObject({
			ok: false,
			code: "PRICING_MODEL_UNAVAILABLE",
		});
		const result = quoteAvailablePricing(
			"sandbox",
			developerPricing(scope, scenario("0")),
		);
		expect(result).toMatchObject({
			ok: true,
			source: "developer-supplied",
			modelId: "contract-a",
			revision: "1",
			quote: { incremental: { billed: { decimal: "0", currency: "USD" } } },
		});
	});

	it("rates a supplied model and reports its provenance", () => {
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, scenario())),
		).toMatchObject({
			ok: true,
			source: "developer-supplied",
			modelId: "contract-a",
			revision: "1",
			quote: { incremental: { billed: { decimal: "1", currency: "USD" } } },
		});
	});

	it.each([
		["provider", { providerId: "other" }],
		["tenant", { tenantId: "other" }],
		["account", { providerAccountRef: "other" }],
		["product", { productId: "other" }],
	])("rejects a model with a mismatched %s scope", (_field, override) => {
		expect(
			quoteAvailablePricing(
				"sandbox",
				developerPricing({ ...scope, ...override }, scenario()),
			),
		).toMatchObject({
			ok: false,
			code: "PRICING_MODEL_SCOPE_MISMATCH",
		});
	});

	it("refuses missing or unmodeled usage instead of rating it as zero", () => {
		const missing = scenario();
		const missingWorkload = missing.candidate[0];
		if (missingWorkload === undefined)
			throw new Error("fixture workload missing");
		missingWorkload.usage = [];
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, missing)),
		).toMatchObject({
			ok: false,
			code: "PRICING_MODEL_INCOMPLETE",
		});
		const extra = scenario();
		const extraMeasurement = extra.candidate[0]?.usage[0];
		if (extraMeasurement === undefined)
			throw new Error("fixture usage missing");
		extraMeasurement.dimension = "network";
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, extra)),
		).toMatchObject({
			ok: false,
			code: "PRICING_MODEL_INCOMPLETE",
		});
	});

	it("rejects an empty workload and duplicate meter definitions", () => {
		const noWork = scenario();
		noWork.candidate = [];
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, noWork)),
		).toMatchObject({
			ok: false,
			code: "PRICING_MODEL_INCOMPLETE",
		});
		const duplicate = scenario();
		const product = duplicate.catalog?.products[0];
		const meter = product?.meters[0];
		if (product === undefined || meter === undefined)
			throw new Error("fixture meter missing");
		product.meters.push(meter);
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, duplicate)),
		).toMatchObject({
			ok: false,
			code: "PRICING_MODEL_INCOMPLETE",
		});
	});

	it("rejects a rate-card charge whose dimension would otherwise be skipped", () => {
		const incomplete = scenario();
		const card = incomplete.catalog?.rateCards[0];
		const firstCharge = card?.charges[0];
		if (card === undefined || firstCharge === undefined)
			throw new Error("fixture charge missing");
		const egress = clone(ChargeComponentSchema, firstCharge);
		if (egress.variant.case !== "usage" || egress.base === undefined)
			throw new Error("fixture usage charge missing");
		egress.base.id = "egress";
		egress.variant.value.dimension = "egress";
		card.charges.push(egress);
		rehashScenario(incomplete);
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, incomplete)),
		).toMatchObject({
			ok: false,
			code: "PRICING_MODEL_INCOMPLETE",
		});
	});

	it("refuses partial financial state even when partial quotes were opted into", () => {
		const partial = scenario();
		if (partial.state === undefined || partial.options === undefined)
			throw new Error("fixture state or options missing");
		partial.state.completeness = "partial";
		partial.options.allowPartialFinancialState = true;
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, partial)),
		).toMatchObject({
			ok: false,
			code: "INCOMPLETE_FINANCIAL_STATE",
		});
	});

	it("propagates stale evidence and does not fall back to another price", () => {
		const stale = scenario();
		const observation = stale.state?.observations[0];
		if (observation === undefined)
			throw new Error("fixture observation missing");
		observation.validUntil = "2026-01-01T00:00:00Z";
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, stale)),
		).toMatchObject({
			ok: false,
			code: "STALE_OBSERVATION",
		});
	});
});
