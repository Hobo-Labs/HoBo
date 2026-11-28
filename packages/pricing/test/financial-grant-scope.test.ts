import { describe, expect, it } from "vitest";
import { quoteScenario } from "../src/quote.js";
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

function makeScopedScenario() {
	return makeScenario({
		charges: [perUnitCharge("runtime", "minute", "1")],
		candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
		allowances: [allowanceState("allowance-a", "10", "0")],
		credits: [creditState("credit-a", "zero", 0)],
		commitments: [commitmentState()],
	});
}

describe("explicit financial grant scopes", () => {
	it.each([
		"allowance",
		"credit",
		"commitment",
	] as const)("rejects a missing %s scope instead of treating it as universal", (kind) => {
		const scenario = makeScopedScenario();
		const grant =
			kind === "allowance"
				? scenario.state?.allowances[0]?.grant
				: kind === "credit"
					? scenario.state?.credits[0]?.grant
					: scenario.state?.commitments[0]?.commitment;
		if (!grant) throw new Error("missing grant fixture");
		grant.scope = undefined;
		rehashScenario(scenario);
		expect(quoteScenario(scenario)).toMatchObject({
			code: "INVALID_PRICING_INPUT",
		});
	});

	it.each([
		"productIds",
		"rateCardIds",
		"chargeIds",
		"dimensions",
	] as const)("rejects empty identifiers in %s", (field) => {
		const scenario = makeScopedScenario();
		const scope = scenario.state?.credits[0]?.grant?.scope;
		if (!scope) throw new Error("missing scope fixture");
		scope[field].push("");
		rehashScenario(scenario);
		expect(quoteScenario(scenario)).toMatchObject({
			code: "INVALID_PRICING_INPUT",
		});
	});

	it("accepts a deliberately universal scope", () => {
		expect(quoteScenario(makeScopedScenario())).toMatchObject({
			$typeName: "hobo.pricing.v1.QuoteVector",
		});
	});

	it("applies a credit only when its explicit scope matches", () => {
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "1")],
			candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
			credits: [creditState("credit-a", "zero", 0)],
		});
		const scope = scenario.state?.credits[0]?.grant?.scope;
		if (!scope) throw new Error("missing scope fixture");
		scope.productIds = ["other-product"];
		rehashScenario(scenario);
		expect(quoteScenario(scenario)).toMatchObject({
			candidate: { billed: { decimal: "4", currency: "USD" } },
		});
		scope.productIds = ["sandbox"];
		rehashScenario(scenario);
		expect(quoteScenario(scenario)).toMatchObject({
			candidate: { billed: { decimal: "0", currency: "USD" } },
		});
	});
});
