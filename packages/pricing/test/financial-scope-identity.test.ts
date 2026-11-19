import { describe, expect, it } from "vitest";
import { quoteScenarioV2 } from "../src/quote.js";
import {
	createTargetPricingInventory,
	quoteTargetPricing,
	targetPricingModel,
} from "../src/target-pricing.js";
import {
	allowanceState,
	commitmentState,
	creditState,
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

const digest = `sha256:${"a".repeat(64)}`;

function quoteTarget(scenario: ReturnType<typeof makeScenario>) {
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
	return quoteTargetPricing(
		inventory,
		targetPricingModel({
			modelId: "terms",
			revision: "1",
			planDigest: digest,
			scenario,
			bindings: [{ resourceId: "service", candidateIndex: 0 }],
		}),
	);
}

describe("unique financial scope identities", () => {
	it("records spend commitment consumption in the rate-card currency", () => {
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "1")],
			candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
			commitments: [commitmentState()],
		});
		expect(quoteScenarioV2(scenario)).toMatchObject({
			$typeName: "hobo.pricing.v1.QuoteVector",
			consumption: [
				{
					sourceId: "commitment-a",
					kind: "commitment",
					quantity: { decimal: "4", unit: "USD" },
				},
			],
		});
	});
	it.each([
		"credits",
		"allowance-and-credit",
		"credit-and-commitment",
	] as const)("rejects repeated entitlement identity across %s", (kind) => {
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "1")],
			candidate: [workload("agreement-a", [usage("minute", "15", "minute")])],
			credits: [
				creditState("shared", "zero", 0),
				...(kind === "credits"
					? [creditState("shared", "acquisition", 0)]
					: []),
			],
			allowances:
				kind === "allowance-and-credit"
					? [allowanceState("shared", "10", "0")]
					: [],
			commitments: kind === "credit-and-commitment" ? [commitmentState()] : [],
		});
		if (kind === "credit-and-commitment") {
			const commitment = scenario.state?.commitments[0]?.commitment;
			if (!commitment) throw new Error("missing commitment fixture");
			commitment.id = "shared";
			rehashScenario(scenario);
		}
		expect(quoteScenarioV2(scenario)).toMatchObject({
			code: "INVALID_PRICING_INPUT",
		});
		expect(quoteTarget(scenario)).toMatchObject({
			ok: false,
			code: "INVALID_PRICING_INPUT",
		});
	});

	it.each([
		"",
		" spaced ",
		"invalid\nname",
		"a".repeat(201),
	])("rejects an invalid entitlement identity %s", (id) => {
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "1")],
			candidate: [workload("agreement-a", [usage("minute", "1", "minute")])],
			credits: [creditState(id, "zero", 0)],
		});
		expect(quoteScenarioV2(scenario)).toMatchObject({
			code: "INVALID_PRICING_INPUT",
		});
	});

	it("accepts distinct scope identities", () => {
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "1")],
			candidate: [workload("agreement-a", [usage("minute", "15", "minute")])],
			credits: [
				creditState("first", "zero", 0),
				creditState("second", "zero", 0),
			],
		});
		expect(quoteTarget(scenario)).toMatchObject({ ok: true });
	});
});
