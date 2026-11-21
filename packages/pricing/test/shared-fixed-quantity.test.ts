import { clone } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ProviderAgreementSchema,
	RateCardSchema,
} from "../src/_generated/pricing_pb.js";
import {
	developerPricing,
	quoteAvailablePricing,
} from "../src/availability.js";
import { quoteScenario, quoteScenarioV2 } from "../src/quote.js";
import {
	assessTargetPricing,
	createTargetPricingInventory,
	targetPricingModel,
} from "../src/target-pricing.js";
import { isQuoteVector } from "../src/types.js";
import {
	creditState,
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
const resource = {
	resourceId: "resource-a",
	providerId: scope.providerId,
	providerAccountRef: scope.providerAccountRef,
	productId: scope.productId,
};

function scenarioWithOtherAgreement(quantity?: string, status = "active") {
	const scenario = makeScenario({
		charges: [perUnitCharge("runtime", "minute", "1")],
		candidate: [workload("agreement-a", [usage("minute", "10", "minute")])],
		credits: [creditState("shared", "zero", 0)],
	});
	const source = scenario.state?.agreements[0];
	const sourceCard = scenario.catalog?.rateCards[0];
	if (!scenario.state || !scenario.catalog || !source || !sourceCard)
		throw new Error("missing agreement fixture");
	const other = clone(ProviderAgreementSchema, source);
	other.id = "agreement-b";
	other.providerAccountRef = "account-b";
	other.status = status;
	for (const entry of other.rateSchedule) entry.rateCardId = "card-b";
	if (quantity !== undefined) other.quantities.seat = quantity;
	scenario.state.agreements.push(other);
	const card = clone(RateCardSchema, sourceCard);
	card.id = "card-b";
	const fixed = makeScenario({ charges: [fixedCharge("seat", "10")] }).catalog
		?.rateCards[0]?.charges[0];
	if (fixed?.variant.case !== "fixed") throw new Error("missing fixed charge");
	fixed.variant.value.quantityDimension = "seat";
	card.charges.push(fixed);
	scenario.catalog.rateCards.push(card);
	return rehashScenario(scenario);
}

function assessment(scenario: ReturnType<typeof scenarioWithOtherAgreement>) {
	const inventory = createTargetPricingInventory({
		targetId: "target-a",
		tenantId: "tenant-a",
		planDigest: digest,
		complete: true,
		evidenceRef: "inventory:1",
		resources: [resource],
	});
	const model = targetPricingModel({
		modelId: scope.modelId,
		revision: scope.revision,
		planDigest: digest,
		scenario,
		bindings: [{ resourceId: resource.resourceId, candidateIndex: 0 }],
	});
	return assessTargetPricing(inventory, model);
}

describe("fixed quantities on other billable agreements", () => {
	it.each([
		["active", false],
		["active", true],
		["past-due", false],
		["past-due", true],
	] as const)("rejects a missing quantity for a %s agreement with target quantity present: %s", (status, targetHasQuantity) => {
		const scenario = scenarioWithOtherAgreement(undefined, status);
		if (targetHasQuantity) {
			const candidate = scenario.candidate[0];
			if (!candidate) throw new Error("missing candidate");
			candidate.quantities.seat = "3";
			rehashScenario(scenario);
		}
		expect(quoteScenarioV2(scenario)).toMatchObject({
			code: "PRICING_FIXED_QUANTITY_UNAVAILABLE",
		});
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, scenario)),
		).toMatchObject({ ok: false, code: "PRICING_MODEL_INCOMPLETE" });
		expect(assessment(scenario)).toMatchObject({
			quote: { ok: false, code: "TARGET_PRICING_INCOMPLETE" },
			providerCoverage: {
				providers: [{ providerId: "sandbox", status: "unverified" }],
			},
		});
	});

	it("accepts an explicit zero and rates a positive quantity against shared credits", () => {
		const zero = quoteScenarioV2(scenarioWithOtherAgreement("0"));
		const positive = quoteScenarioV2(scenarioWithOtherAgreement("1"));
		expect(isQuoteVector(zero)).toBe(true);
		expect(isQuoteVector(positive)).toBe(true);
		if (!isQuoteVector(zero) || !isQuoteVector(positive))
			throw new Error("expected complete quotes");
		expect(zero.incremental?.billed?.decimal).toBe("0");
		expect(positive.incremental?.billed?.decimal).toBe("10");
	});

	it("includes an unrelated past-due agreement in shared credit consumption", () => {
		const quote = quoteScenarioV2(scenarioWithOtherAgreement("1", "past-due"));
		expect(isQuoteVector(quote)).toBe(true);
		if (!isQuoteVector(quote)) throw new Error("expected complete quote");
		expect(quote.incremental?.billed?.decimal).toBe("10");
	});

	it("does not assume an unrelated trial consumes no shared credit", () => {
		const scenario = scenarioWithOtherAgreement("1", "trialing");
		expect(quoteScenarioV2(scenario)).toMatchObject({
			code: "PRICING_AGREEMENT_UNAVAILABLE",
			message: expect.stringContaining("explicit workload"),
		});
		const legacy = quoteScenario(scenario);
		if (!isQuoteVector(legacy)) throw new Error("expected legacy quote");
		expect(legacy.incremental?.billed?.decimal).toBe("0");
	});

	it("validates the billing period of an unrelated past-due agreement", () => {
		const scenario = scenarioWithOtherAgreement("1", "past-due");
		const period = scenario.state?.agreements[1]?.billingPeriod;
		if (!period) throw new Error("missing billing period");
		period.anchor = "2025-01-31T00:00:00Z";
		expect(quoteScenarioV2(rehashScenario(scenario))).toMatchObject({
			code: "PRICING_MODEL_UNSUPPORTED",
		});
	});

	it("requires explicit quantities on each workload sharing an agreement", () => {
		const scenario = scenarioWithOtherAgreement("0");
		const other = scenario.state?.agreements[1];
		const candidate = scenario.candidate[0];
		if (!other || !candidate) throw new Error("missing fixture");
		candidate.agreementRef = other.id;
		expect(quoteScenarioV2(rehashScenario(scenario))).toMatchObject({
			code: "PRICING_FIXED_QUANTITY_UNAVAILABLE",
		});
		candidate.quantities.seat = "0";
		expect(isQuoteVector(quoteScenarioV2(rehashScenario(scenario)))).toBe(true);
	});

	it("rejects an unknown fixed-charge selector on an agreement with no workload", () => {
		const scenario = scenarioWithOtherAgreement();
		const fixed = scenario.catalog?.rateCards[1]?.charges.find(
			(charge) => charge.variant.case === "fixed",
		);
		if (!fixed?.base) throw new Error("missing fixed charge");
		fixed.base.selectors.region = "west";
		rehashScenario(scenario);
		expect(quoteScenarioV2(scenario)).toMatchObject({
			code: "PRICING_FIXED_SELECTOR_UNAVAILABLE",
		});
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, scenario)),
		).toMatchObject({ ok: false, code: "PRICING_MODEL_INCOMPLETE" });
		expect(assessment(scenario)).toMatchObject({
			quote: { ok: false, code: "TARGET_PRICING_INCOMPLETE" },
		});
		expect(isQuoteVector(quoteScenario(scenario))).toBe(true);
	});

	it("does not require a quantity for a fixed charge known not to apply", () => {
		const scenario = scenarioWithOtherAgreement();
		const fixed = scenario.catalog?.rateCards[1]?.charges.find(
			(charge) => charge.variant.case === "fixed",
		);
		if (!fixed?.base) throw new Error("missing fixed charge");
		fixed.base.selectors.region = "west";
		const evidence = scenarioWithOtherAgreement().candidate[0];
		if (!evidence) throw new Error("missing workload fixture");
		evidence.agreementRef = "agreement-b";
		evidence.attributes.region = "east";
		scenario.baseline.push(evidence);
		rehashScenario(scenario);
		expect(isQuoteVector(quoteScenarioV2(scenario))).toBe(true);
	});

	it("does not infer a missing selector from a workload", () => {
		const scenario = scenarioWithOtherAgreement();
		const fixed = scenario.catalog?.rateCards[1]?.charges.find(
			(charge) => charge.variant.case === "fixed",
		);
		const evidence = scenarioWithOtherAgreement().candidate[0];
		if (!fixed?.base || !evidence) throw new Error("missing fixture");
		fixed.base.selectors.region = "west";
		evidence.agreementRef = "agreement-b";
		scenario.baseline.push(evidence);
		expect(quoteScenarioV2(rehashScenario(scenario))).toMatchObject({
			code: "PRICING_FIXED_SELECTOR_UNAVAILABLE",
		});
	});

	it("retains historical v1 replay behavior", () => {
		expect(isQuoteVector(quoteScenario(scenarioWithOtherAgreement()))).toBe(
			true,
		);
	});
});
