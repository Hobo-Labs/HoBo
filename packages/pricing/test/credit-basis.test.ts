import { describe, expect, it } from "vitest";
import { quoteScenarioV2 } from "../src/quote.js";
import {
	creditState,
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

function scenarioWithCredit() {
	return makeScenario({
		charges: [perUnitCharge("runtime", "minute", "1")],
		candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
		credits: [creditState("paid-credit", "acquisition", 0)],
	});
}

describe("credit basis and currency", () => {
	it.each([
		"missing-basis",
		"unknown-basis",
		"zero-with-acquisition",
		"zero-with-remaining-basis",
		"zero-with-used-basis",
		"derived-with-used-basis",
	] as const)("rejects inconsistent %s terms", (field) => {
		const scenario = scenarioWithCredit();
		const credit = scenario.state?.credits[0];
		if (!credit) throw new Error("missing credit fixture");
		const grant = credit.grant;
		const basis = grant?.economicBasis;
		if (!grant?.scope || !basis || !credit.remainingBasis || !credit.usedBasis)
			throw new Error("missing credit fixture");
		grant.scope.dimensions = ["other"];
		if (field === "missing-basis") grant.economicBasis = undefined;
		if (field === "unknown-basis") {
			basis.kind = "unknown";
			basis.acquisitionAmount = undefined;
		}
		if (field.startsWith("zero-")) {
			basis.kind = "zero";
			if (field !== "zero-with-acquisition")
				basis.acquisitionAmount = undefined;
			credit.remainingBasis.decimal =
				field === "zero-with-remaining-basis" ? "1" : "0";
			credit.usedBasis.decimal = field === "zero-with-used-basis" ? "1" : "0";
		}
		if (field === "derived-with-used-basis") {
			grant.derivedFrom = "included-capacity";
			if (!basis.acquisitionAmount) throw new Error("missing acquisition");
			basis.acquisitionAmount.decimal = "0";
			credit.remainingBasis.decimal = "0";
			credit.usedBasis.decimal = "1";
		}
		rehashScenario(scenario);
		expect(quoteScenarioV2(scenario)).toMatchObject({
			code: "INVALID_PRICING_INPUT",
		});
	});

	it.each([
		"remaining",
		"used",
		"remaining-basis",
		"used-basis",
		"acquisition",
	] as const)("rejects a different currency for %s even when the grant is not selected", (field) => {
		const scenario = scenarioWithCredit();
		const credit = scenario.state?.credits[0];
		if (!credit?.grant?.scope || !credit.grant.economicBasis)
			throw new Error("missing credit fixture");
		credit.grant.scope.dimensions = ["other"];
		const remaining = credit.remaining?.value;
		const used = credit.used?.value;
		const amount =
			field === "remaining"
				? remaining?.case === "money"
					? remaining.value
					: undefined
				: field === "used"
					? used?.case === "money"
						? used.value
						: undefined
					: field === "remaining-basis"
						? credit.remainingBasis
						: field === "used-basis"
							? credit.usedBasis
							: credit.grant.economicBasis.acquisitionAmount;
		if (!amount) throw new Error("missing amount fixture");
		amount.currency = "EUR";
		rehashScenario(scenario);
		expect(quoteScenarioV2(scenario)).toMatchObject({ code: "CROSS_CURRENCY" });
	});

	it("rejects a derived credit with nonzero acquisition basis", () => {
		const scenario = scenarioWithCredit();
		const grant = scenario.state?.credits[0]?.grant;
		if (!grant) throw new Error("missing credit fixture");
		grant.derivedFrom = "included-capacity";
		rehashScenario(scenario);
		expect(quoteScenarioV2(scenario)).toMatchObject({
			code: "INVALID_PRICING_INPUT",
		});
	});

	it("allows a derived credit with zero acquisition basis", () => {
		const scenario = scenarioWithCredit();
		const credit = scenario.state?.credits[0];
		const acquisition = credit?.grant?.economicBasis?.acquisitionAmount;
		if (!credit?.grant || !credit.remainingBasis || !acquisition)
			throw new Error("missing credit fixture");
		credit.grant.derivedFrom = "included-capacity";
		acquisition.decimal = "0";
		credit.remainingBasis.decimal = "0";
		rehashScenario(scenario);
		expect(quoteScenarioV2(scenario)).toMatchObject({
			incremental: { effective: { decimal: "0", currency: "USD" } },
		});
	});

	it.each([
		"0",
		"1",
		"3.59",
	])("rejects a consumption requiring $3.60 of basis when only $%s remains", (remainingBasis) => {
		const scenario = scenarioWithCredit();
		const basis = scenario.state?.credits[0]?.remainingBasis;
		if (!basis) throw new Error("missing basis fixture");
		basis.decimal = remainingBasis;
		rehashScenario(scenario);
		expect(quoteScenarioV2(scenario)).toMatchObject({
			code: "INVALID_PRICING_INPUT",
		});
	});

	it.each([
		"3.6",
		"9",
	])("rates a supported allocation with $%s remaining basis", (remainingBasis) => {
		const scenario = scenarioWithCredit();
		const basis = scenario.state?.credits[0]?.remainingBasis;
		if (!basis) throw new Error("missing basis fixture");
		basis.decimal = remainingBasis;
		rehashScenario(scenario);
		expect(quoteScenarioV2(scenario)).toMatchObject({
			incremental: { effective: { decimal: "3.6", currency: "USD" } },
		});
	});
});
