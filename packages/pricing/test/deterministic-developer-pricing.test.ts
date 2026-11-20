import { describe, expect, it } from "vitest";
import {
	developerPricing,
	quoteAvailablePricing,
} from "../src/availability.js";
import {
	createTargetPricingInventory,
	quoteTargetPricing,
	targetPricingModel,
} from "../src/target-pricing.js";
import {
	creditState,
	makeScenario,
	perUnitCharge,
	usage,
	workload,
} from "./fixtures.js";

const digest = `sha256:${"a".repeat(64)}`;

function scenario(reverse: boolean) {
	const credits = [
		creditState("Z-credit", "zero", 0),
		creditState("a-credit", "acquisition", 0),
	];
	if (reverse) credits.reverse();
	return makeScenario({
		charges: [perUnitCharge("runtime", "minute", "1")],
		candidate: [workload("agreement-a", [usage("minute", "10", "minute")])],
		credits,
	});
}

describe("deterministic developer pricing", () => {
	it.each([
		false,
		true,
	])("consumes tied credits by code-unit ID in target quotes (reverse=%s)", (reverse) => {
		const inventory = createTargetPricingInventory({
			targetId: "target-a",
			tenantId: "tenant-a",
			planDigest: digest,
			complete: true,
			evidenceRef: "inventory:1",
			resources: [
				{
					resourceId: "service",
					providerId: "sandbox",
					providerAccountRef: "account-a",
					productId: "sandbox",
				},
			],
		});
		const pricing = targetPricingModel({
			modelId: "terms",
			revision: "1",
			planDigest: digest,
			scenario: scenario(reverse),
			bindings: [{ resourceId: "service", candidateIndex: 0 }],
		});
		expect(quoteTargetPricing(inventory, pricing)).toMatchObject({
			ok: true,
			quote: {
				ratingAlgorithmVersion: "pricing-rating/v2",
				incremental: { effective: { decimal: "0", currency: "USD" } },
				consumption: [{ sourceId: "Z-credit", kind: "credit" }],
			},
		});
	});

	it("uses the same deterministic algorithm for a single-offering model", () => {
		const availability = developerPricing(
			{
				modelId: "terms",
				revision: "1",
				tenantId: "tenant-a",
				providerId: "sandbox",
				providerAccountRef: "account-a",
				productId: "sandbox",
			},
			scenario(false),
		);
		expect(quoteAvailablePricing("sandbox", availability)).toMatchObject({
			ok: true,
			quote: {
				ratingAlgorithmVersion: "pricing-rating/v2",
				incremental: { effective: { decimal: "0", currency: "USD" } },
				consumption: [{ sourceId: "Z-credit", kind: "credit" }],
			},
		});
	});

	it("does not consult locale collation when quoting a supplied model", () => {
		const availability = developerPricing(
			{
				modelId: "terms",
				revision: "1",
				tenantId: "tenant-a",
				providerId: "sandbox",
				providerAccountRef: "account-a",
				productId: "sandbox",
			},
			scenario(false),
		);
		const expected = quoteAvailablePricing("sandbox", availability);
		const original = Object.getOwnPropertyDescriptor(
			String.prototype,
			"localeCompare",
		);
		if (!original) throw new Error("missing locale comparison intrinsic");
		let withoutLocale: ReturnType<typeof quoteAvailablePricing>;
		try {
			Object.defineProperty(String.prototype, "localeCompare", {
				...original,
				value: () => {
					throw new Error("unexpected locale collation");
				},
			});
			withoutLocale = quoteAvailablePricing("sandbox", availability);
		} finally {
			Object.defineProperty(String.prototype, "localeCompare", original);
		}
		expect(expected.ok).toBe(true);
		expect(withoutLocale).toEqual(expected);
	});
});
