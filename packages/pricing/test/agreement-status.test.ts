import { clone } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { ProviderAgreementSchema } from "../src/_generated/pricing_pb.js";
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

function scenarioWithStatus(
	status: string,
	use: "candidate" | "baseline" | "unreferenced",
) {
	const measurement = () => [usage("minute", "4", "minute")];
	const scenario = makeScenario({
		charges: [perUnitCharge("runtime", "minute", "0.25")],
		baseline:
			use === "baseline" ? [workload("agreement-a", measurement())] : [],
		candidate: [
			workload(
				use === "candidate" ? "agreement-a" : "agreement-b",
				measurement(),
			),
		],
	});
	const state = scenario.state;
	const agreement = state?.agreements[0];
	if (!state || !agreement) throw new Error("missing agreement fixture");
	const background = clone(ProviderAgreementSchema, agreement);
	background.id = "agreement-b";
	state.agreements.push(background);
	agreement.status = status;
	return rehashScenario(scenario);
}

describe("provider agreement status in v2 pricing", () => {
	it.each([
		"suspended",
		"cancelled",
		"",
		"future-status",
	])("refuses %s agreements referenced by a workload", (status) => {
		for (const use of ["baseline", "candidate"] as const) {
			const scenario = scenarioWithStatus(status, use);
			expect(quoteScenarioV2(scenario)).toMatchObject({
				code: "PRICING_AGREEMENT_UNAVAILABLE",
			});
		}
	});

	it.each([
		"suspended",
		"cancelled",
	])("propagates an unavailable %s agreement through both developer pricing APIs", (status) => {
		const scenario = scenarioWithStatus(status, "candidate");
		expect(
			quoteAvailablePricing("sandbox", developerPricing(scope, scenario)),
		).toMatchObject({
			ok: false,
			code: "PRICING_AGREEMENT_UNAVAILABLE",
		});
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
		expect(assessTargetPricing(inventory, model)).toMatchObject({
			quote: { ok: false, code: "PRICING_AGREEMENT_UNAVAILABLE" },
			providerCoverage: {
				providers: [{ providerId: "sandbox", status: "unverified" }],
			},
		});
	});

	it.each([
		"active",
		"past-due",
	])("allows a referenced %s agreement", (status) => {
		expect(
			isQuoteVector(quoteScenarioV2(scenarioWithStatus(status, "candidate"))),
		).toBe(true);
	});

	it("keeps trial agreements subject to the new-agreement policy", () => {
		const scenario = scenarioWithStatus("trialing", "candidate");
		expect(quoteScenarioV2(scenario)).toMatchObject({
			code: "NEW_AGREEMENT_DENIED",
		});
		if (!scenario.options) throw new Error("missing options");
		scenario.options.allowNewProviderAgreement = true;
		expect(isQuoteVector(quoteScenarioV2(scenario))).toBe(true);
	});

	it.each([
		"suspended",
		"cancelled",
	])("does not reject an unrelated %s agreement", (status) => {
		expect(
			isQuoteVector(
				quoteScenarioV2(scenarioWithStatus(status, "unreferenced")),
			),
		).toBe(true);
	});

	it("preserves legacy v1 quote behavior for historical replay", () => {
		expect(
			isQuoteVector(
				quoteScenario(scenarioWithStatus("cancelled", "candidate")),
			),
		).toBe(true);
	});
});
