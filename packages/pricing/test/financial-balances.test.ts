import { describe, expect, it } from "vitest";
import { quoteScenarioV2 } from "../src/quote.js";
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

function scenarioWithBalances() {
	return makeScenario({
		charges: [perUnitCharge("runtime", "minute", "1")],
		candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
		allowances: [allowanceState("allowance-a", "10", "0")],
		credits: [creditState("credit-a", "acquisition", 0)],
		commitments: [commitmentState()],
	});
}

describe("financial balances", () => {
	it.each([
		"allowance-included",
		"allowance-remaining",
		"allowance-used",
		"credit-face",
		"credit-remaining",
		"credit-used",
		"credit-acquisition",
		"credit-remaining-basis",
		"credit-used-basis",
		"commitment-amount",
		"commitment-remaining",
		"commitment-used",
	] as const)("rejects a negative %s even if it is not consumed", (field) => {
		const scenario = scenarioWithBalances();
		const allowance = scenario.state?.allowances[0];
		const credit = scenario.state?.credits[0];
		const commitment = scenario.state?.commitments[0];
		const values = {
			"allowance-included": allowance?.grant?.included,
			"allowance-remaining": allowance?.remaining,
			"allowance-used": allowance?.used,
			"credit-face":
				credit?.grant?.faceValue?.value.case === "money"
					? credit.grant.faceValue.value.value
					: undefined,
			"credit-remaining":
				credit?.remaining?.value.case === "money"
					? credit.remaining.value.value
					: undefined,
			"credit-used":
				credit?.used?.value.case === "money"
					? credit.used.value.value
					: undefined,
			"credit-acquisition": credit?.grant?.economicBasis?.acquisitionAmount,
			"credit-remaining-basis": credit?.remainingBasis,
			"credit-used-basis": credit?.usedBasis,
			"commitment-amount":
				commitment?.commitment?.amount?.value.case === "money"
					? commitment.commitment.amount.value.value
					: undefined,
			"commitment-remaining":
				commitment?.remaining?.value.case === "money"
					? commitment.remaining.value.value
					: undefined,
			"commitment-used":
				commitment?.used?.value.case === "money"
					? commitment.used.value.value
					: undefined,
		};
		const value = values[field];
		if (!value) throw new Error(`missing ${field} fixture`);
		value.decimal = "-1";
		rehashScenario(scenario);
		expect(quoteScenarioV2(scenario)).toMatchObject({
			code: "INVALID_PRICING_INPUT",
		});
	});

	it("accepts valid zero and positive balances", () => {
		expect(quoteScenarioV2(scenarioWithBalances())).toMatchObject({
			$typeName: "hobo.pricing.v1.QuoteVector",
		});
	});

	it.each([
		"missing-used",
		"invalid-currency",
		"empty-unit",
	] as const)("rejects a %s balance", (field) => {
		const scenario = scenarioWithBalances();
		const allowance = scenario.state?.allowances[0];
		const credit = scenario.state?.credits[0];
		if (!allowance?.used || !credit?.remainingBasis)
			throw new Error("missing balance fixture");
		const used = allowance.used;
		if (field === "missing-used") allowance.used = undefined;
		if (field === "invalid-currency") credit.remainingBasis.currency = "usd";
		if (field === "empty-unit") used.unit = "";
		rehashScenario(scenario);
		expect(quoteScenarioV2(scenario)).toMatchObject({
			code: "INVALID_PRICING_INPUT",
		});
	});
});
