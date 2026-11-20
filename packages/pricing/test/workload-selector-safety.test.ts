import { describe, expect, it } from "vitest";
import { quoteScenario } from "../src/quote.js";
import {
	createTargetPricingInventory,
	quoteTargetPricing,
	targetPricingModel,
} from "../src/target-pricing.js";
import {
	fixedCharge,
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

const planDigest = `sha256:${"a".repeat(64)}`;

function selectedScenario() {
	const scenario = makeScenario({
		charges: [
			perUnitCharge("east", "minute", "1"),
			perUnitCharge("west", "minute", "100"),
		],
		candidate: [
			workload("agreement-a", [usage("minute", "1", "minute")]),
			workload("agreement-a", [usage("minute", "1", "minute")]),
		],
	});
	const card = scenario.catalog?.rateCards[0];
	const east = card?.charges[0]?.base;
	const west = card?.charges[1]?.base;
	const first = scenario.candidate[0];
	const second = scenario.candidate[1];
	if (!east || !west || !first || !second) throw new Error("invalid fixture");
	east.selectors = { region: "east" };
	west.selectors = { region: "west" };
	first.attributes = { region: "east" };
	second.attributes = { region: "west" };
	rehashScenario(scenario);
	return scenario;
}

function targetQuote(scenario: ReturnType<typeof selectedScenario>) {
	const target = createTargetPricingInventory({
		targetId: "target-a",
		tenantId: "tenant-a",
		planDigest,
		complete: true,
		evidenceRef: "inventory:attested",
		resources: scenario.candidate.map((_, index) => ({
			resourceId: `resource-${index}`,
			providerId: "sandbox",
			providerAccountRef: "account-a",
			productId: "sandbox",
		})),
	});
	const model = targetPricingModel({
		modelId: "regional-prices",
		revision: "1",
		planDigest,
		scenario,
		bindings: scenario.candidate.map((_, candidateIndex) => ({
			resourceId: `resource-${candidateIndex}`,
			candidateIndex,
		})),
	});
	return quoteTargetPricing(target, model);
}

describe("workload selectors and shared agreements", () => {
	it.each([
		false,
		true,
	])("rejects different selected attributes for two candidates in either order (reverse=%s)", (reverse) => {
		const scenario = selectedScenario();
		if (reverse) scenario.candidate.reverse();
		expect(quoteScenario(scenario)).toMatchObject({
			code: "PRICING_MODEL_UNSUPPORTED",
		});
		expect(targetQuote(scenario)).toMatchObject({
			ok: false,
			code: "PRICING_MODEL_UNSUPPORTED",
		});
	});

	it("rejects selected attributes that differ between baseline and candidate", () => {
		const scenario = selectedScenario();
		const baseline = scenario.candidate.shift();
		if (!baseline) throw new Error("missing baseline fixture");
		scenario.baseline.push(baseline);
		expect(quoteScenario(scenario)).toMatchObject({
			code: "PRICING_MODEL_UNSUPPORTED",
		});
		expect(targetQuote(scenario)).toMatchObject({
			ok: false,
			code: "PRICING_MODEL_UNSUPPORTED",
		});
	});

	it("rejects an absent selector attribute mixed with a present one", () => {
		const scenario = selectedScenario();
		const first = scenario.candidate[0];
		if (!first) throw new Error("missing workload fixture");
		first.attributes = {};
		expect(quoteScenario(scenario)).toMatchObject({
			code: "PRICING_MODEL_UNSUPPORTED",
		});
	});

	it("checks every pair of present and absent selector values", () => {
		for (const left of ["east", "west", undefined]) {
			for (const right of ["east", "west", undefined]) {
				const scenario = selectedScenario();
				const first = scenario.candidate[0];
				const second = scenario.candidate[1];
				if (!first || !second) throw new Error("missing workload fixture");
				first.attributes = left === undefined ? {} : { region: left };
				second.attributes = right === undefined ? {} : { region: right };
				const result = quoteScenario(scenario);
				if (left !== right)
					expect(result).toMatchObject({ code: "PRICING_MODEL_UNSUPPORTED" });
				else if (left === undefined)
					expect(result).toMatchObject({ code: "RATE_CARD_NOT_FOUND" });
				else expect(result.$typeName).toBe("hobo.pricing.v1.QuoteVector");
			}
		}
	});

	it("checks baseline workloads before the candidate snapshot", () => {
		const scenario = selectedScenario();
		scenario.baseline.push(...scenario.candidate);
		scenario.candidate = [];
		expect(quoteScenario(scenario)).toMatchObject({
			code: "PRICING_MODEL_UNSUPPORTED",
		});
	});

	it("checks selectors on fixed charges as well as usage charges", () => {
		const scenario = makeScenario({
			charges: [
				fixedCharge("regional-fee", "10"),
				perUnitCharge("runtime", "minute", "1"),
			],
			candidate: [
				workload("agreement-a", [usage("minute", "1", "minute")]),
				workload("agreement-a", [usage("minute", "1", "minute")]),
			],
		});
		const fixed = scenario.catalog?.rateCards[0]?.charges[0]?.base;
		const first = scenario.candidate[0];
		const second = scenario.candidate[1];
		if (!fixed || !first || !second) throw new Error("invalid fixture");
		fixed.selectors = { region: "east" };
		first.attributes = { region: "east" };
		second.attributes = { region: "west" };
		rehashScenario(scenario);
		expect(quoteScenario(scenario)).toMatchObject({
			code: "PRICING_MODEL_UNSUPPORTED",
		});
	});

	it("allows different attributes when no charge selects them", () => {
		const scenario = selectedScenario();
		const first = scenario.candidate[0];
		const second = scenario.candidate[1];
		if (!first || !second) throw new Error("missing workload fixture");
		first.attributes = { region: "east", instance: "one" };
		second.attributes = { region: "east", instance: "two" };
		expect(targetQuote(scenario)).toMatchObject({
			ok: true,
			quote: { incremental: { billed: { decimal: "2", currency: "USD" } } },
		});
	});

	it("treats reserved selector keys as workload fields, not attributes", () => {
		const scenario = selectedScenario();
		const first = scenario.candidate[0];
		const second = scenario.candidate[1];
		const east = scenario.catalog?.rateCards[0]?.charges[0]?.base;
		if (!first || !second || !east) throw new Error("invalid fixture");
		east.selectors = {
			region: "east",
			productId: "sandbox",
			agreementRef: "agreement-a",
			dimension: "minute",
		};
		first.attributes = { region: "east", productId: "ignored-a" };
		second.attributes = { region: "east", productId: "ignored-b" };
		rehashScenario(scenario);
		expect(targetQuote(scenario)).toMatchObject({
			ok: true,
			quote: { incremental: { billed: { decimal: "2", currency: "USD" } } },
		});
	});

	it("allows different selector attributes on separate agreements", () => {
		const scenario = selectedScenario();
		const agreement = scenario.state?.agreements[0];
		const second = scenario.candidate[1];
		if (!agreement || !second || !scenario.state)
			throw new Error("invalid fixture");
		scenario.state.agreements.push({ ...agreement, id: "agreement-b" });
		second.agreementRef = "agreement-b";
		rehashScenario(scenario);
		expect(targetQuote(scenario)).toMatchObject({
			ok: true,
			quote: { incremental: { billed: { decimal: "101", currency: "USD" } } },
		});
	});
});
