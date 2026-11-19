import { clone, create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ChargeComponentSchema,
	PackagePriceSchema,
	ProviderAgreementSchema,
	RateCardSchema,
	TieredPriceSchema,
	TierSchema,
} from "../src/_generated/pricing_pb.js";
import {
	developerPricing,
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

describe("developer pricing rejection specifications", () => {
	it("rejects an empty rate card on an extra in-scope active agreement", () => {
		const incomplete = scenario();
		const state = incomplete.state;
		const source = state?.agreements[0];
		const sourceCard = incomplete.catalog?.rateCards[0];
		if (state === undefined || source === undefined || sourceCard === undefined)
			throw new Error("fixture agreement missing");
		const agreement = clone(ProviderAgreementSchema, source);
		agreement.id = "agreement-b";
		for (const entry of agreement.rateSchedule) entry.rateCardId = "empty-card";
		state.agreements.push(agreement);
		const rateCard = clone(RateCardSchema, sourceCard);
		rateCard.id = "empty-card";
		rateCard.charges = [];
		incomplete.catalog?.rateCards.push(rateCard);
		rehashScenario(incomplete);
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, incomplete)),
		).toMatchObject({ ok: false, code: "INVALID_PRICING_INPUT" });
	});

	it("rejects malformed quote intervals without throwing", () => {
		const broken = scenario();
		broken.at = "not-a-date";
		rehashScenario(broken);
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, broken)),
		).toMatchObject({
			ok: false,
			code: "INVALID_PRICING_INPUT",
		});
	});

	it("rejects graduated usage charges with hollow tiers", () => {
		const incomplete = scenario();
		const card = incomplete.catalog?.rateCards[0];
		const firstCharge = card?.charges[0];
		if (card === undefined || firstCharge === undefined)
			throw new Error("fixture charge missing");
		const tiered = clone(ChargeComponentSchema, firstCharge);
		if (tiered.variant.case !== "usage" || tiered.base === undefined)
			throw new Error("fixture usage charge missing");
		tiered.variant.value.price = {
			case: "graduated",
			value: create(TieredPriceSchema, {
				tiers: [
					create(TierSchema, {
						from: "0",
						unitAmount: { decimal: "", currency: "USD" },
					}),
				],
			}),
		};
		card.charges = [tiered];
		rehashScenario(incomplete);
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, incomplete)),
		).toMatchObject({ ok: false, code: "INVALID_PRICING_INPUT" });
	});

	it("rejects a charge component without a base id", () => {
		const incomplete = scenario();
		const card = incomplete.catalog?.rateCards[0];
		if (card === undefined) throw new Error("fixture rate card missing");
		card.charges.push(
			create(ChargeComponentSchema, {
				variant: {
					case: "fixed",
					value: {
						cadence: "monthly",
						timing: "advance",
						amount: { decimal: "10", currency: "USD" },
						proration: "none",
					},
				},
			}),
		);
		rehashScenario(incomplete);
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, incomplete)),
		).toMatchObject({ ok: false, code: "INVALID_PRICING_INPUT" });
	});

	it("rejects fixed charges on active agreements without workloads", () => {
		const incomplete = scenario();
		const state = incomplete.state;
		const card = incomplete.catalog?.rateCards[0];
		if (state === undefined || card === undefined)
			throw new Error("fixture state or rate card missing");
		card.charges.push(
			create(ChargeComponentSchema, {
				base: {
					id: "seat",
					selectors: {},
					fallback: false,
					invoiceBehavior: "itemized",
				},
				variant: {
					case: "fixed",
					value: {
						cadence: "monthly",
						timing: "advance",
						amount: { decimal: "10", currency: "USD" },
						quantityDimension: "seat",
						proration: "none",
					},
				},
			}),
		);
		const source = state.agreements[0];
		if (source === undefined) throw new Error("fixture agreement missing");
		const extra = clone(ProviderAgreementSchema, source);
		extra.id = "agreement-b";
		state.agreements.push(extra);
		rehashScenario(incomplete);
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, incomplete)),
		).toMatchObject({
			ok: false,
			code: "PRICING_MODEL_INCOMPLETE",
		});
	});

	it("rejects a fixed charge whose quantity dimension is not supplied", () => {
		const incomplete = scenario();
		const card = incomplete.catalog?.rateCards[0];
		if (card === undefined) throw new Error("fixture rate card missing");
		card.charges.push(
			create(ChargeComponentSchema, {
				base: {
					id: "seat",
					selectors: {},
					fallback: false,
					invoiceBehavior: "itemized",
				},
				variant: {
					case: "fixed",
					value: {
						cadence: "monthly",
						timing: "advance",
						amount: { decimal: "10", currency: "USD" },
						quantityDimension: "seat",
						proration: "none",
					},
				},
			}),
		);
		rehashScenario(incomplete);
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, incomplete)),
		).toMatchObject({
			ok: false,
			code: "PRICING_MODEL_INCOMPLETE",
		});
	});

	it("rejects a one-sided tier and a package price without a size", () => {
		const tieredScenario = scenario();
		const tieredCard = tieredScenario.catalog?.rateCards[0];
		const firstCharge = tieredCard?.charges[0];
		if (tieredCard === undefined || firstCharge === undefined)
			throw new Error("fixture charge missing");
		const tiered = clone(ChargeComponentSchema, firstCharge);
		if (tiered.variant.case !== "usage" || tiered.base === undefined)
			throw new Error("fixture usage charge missing");
		tiered.variant.value.price = {
			case: "graduated",
			value: create(TieredPriceSchema, {
				tiers: [
					create(TierSchema, {
						from: "0",
						unitAmount: { decimal: "1", currency: "USD" },
					}),
				],
			}),
		};
		tieredCard.charges = [tiered];
		rehashScenario(tieredScenario);
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, tieredScenario)),
		).toMatchObject({ ok: false, code: "INVALID_PRICING_INPUT" });

		const packaged = scenario();
		const packagedCard = packaged.catalog?.rateCards[0];
		const packagedCharge = packagedCard?.charges[0];
		if (packagedCard === undefined || packagedCharge === undefined)
			throw new Error("fixture charge missing");
		const packageCharge = clone(ChargeComponentSchema, packagedCharge);
		if (packageCharge.variant.case !== "usage")
			throw new Error("fixture usage charge missing");
		packageCharge.variant.value.price = {
			case: "package",
			value: create(PackagePriceSchema, {
				packageSize: "",
				packageAmount: { decimal: "1", currency: "USD" },
			}),
		};
		packagedCard.charges = [packageCharge];
		rehashScenario(packaged);
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, packaged)),
		).toMatchObject({ ok: false, code: "INVALID_PRICING_INPUT" });
	});

	it("rejects a fixed charge with no amount", () => {
		const incomplete = scenario();
		const card = incomplete.catalog?.rateCards[0];
		if (card === undefined) throw new Error("fixture rate card missing");
		card.charges.push(
			create(ChargeComponentSchema, {
				base: {
					id: "platform",
					selectors: {},
					fallback: false,
					invoiceBehavior: "itemized",
				},
				variant: {
					case: "fixed",
					value: {
						cadence: "monthly",
						timing: "advance",
						proration: "none",
					},
				},
			}),
		);
		rehashScenario(incomplete);
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, incomplete)),
		).toMatchObject({ ok: false, code: "INVALID_PRICING_INPUT" });
	});

	it("rejects a missing fixed quantity on a past-due agreement the quote still rates", () => {
		const incomplete = scenario();
		const agreement = incomplete.state?.agreements[0];
		const card = incomplete.catalog?.rateCards[0];
		if (agreement === undefined || card === undefined)
			throw new Error("fixture agreement missing");
		agreement.status = "past-due";
		card.charges.push(
			create(ChargeComponentSchema, {
				base: {
					id: "seat",
					selectors: {},
					fallback: false,
					invoiceBehavior: "itemized",
				},
				variant: {
					case: "fixed",
					value: {
						cadence: "monthly",
						timing: "advance",
						amount: { decimal: "10", currency: "USD" },
						quantityDimension: "seat",
						proration: "none",
					},
				},
			}),
		);
		rehashScenario(incomplete);
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, incomplete)),
		).toMatchObject({ ok: false, code: "PRICING_MODEL_INCOMPLETE" });
	});

	it("does not treat another agreement workload quantities as fixed inputs", () => {
		const incomplete = scenario();
		const state = incomplete.state;
		const source = state?.agreements[0];
		const sourceCard = incomplete.catalog?.rateCards[0];
		const candidate = incomplete.candidate[0];
		if (
			state === undefined ||
			source === undefined ||
			sourceCard === undefined ||
			candidate === undefined
		) {
			throw new Error("fixture scenario incomplete");
		}
		const agreement = clone(ProviderAgreementSchema, source);
		agreement.id = "agreement-b";
		agreement.providerAccountRef = "account-b";
		for (const entry of agreement.rateSchedule) entry.rateCardId = "card-b";
		state.agreements.push(agreement);
		const rateCard = clone(RateCardSchema, sourceCard);
		rateCard.id = "card-b";
		rateCard.charges.push(
			create(ChargeComponentSchema, {
				base: {
					id: "seat",
					selectors: {},
					fallback: false,
					invoiceBehavior: "itemized",
				},
				variant: {
					case: "fixed",
					value: {
						cadence: "monthly",
						timing: "advance",
						amount: { decimal: "10", currency: "USD" },
						quantityDimension: "seat",
						proration: "none",
					},
				},
			}),
		);
		incomplete.catalog?.rateCards.push(rateCard);
		candidate.quantities = { seat: "3" };
		rehashScenario(incomplete);
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, incomplete)),
		).toMatchObject({ ok: false, code: "PRICING_MODEL_INCOMPLETE" });
	});
});
