import fc from "fast-check";
import { expect, it } from "vitest";
import type {
	CommitmentAmount,
	CreditValue,
	QuoteScenario,
} from "../src/_generated/pricing_pb.js";
import { quoteScenario } from "../src/quote.js";
import { isQuoteVector } from "../src/types.js";
import {
	allowanceState,
	commitmentState,
	creditState,
	fixedCharge,
	makeScenario,
	money,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

type Kind = "allowance" | "credit" | "commitment";
function scenarioFor(kind: Kind): QuoteScenario {
	return makeScenario({
		charges: [perUnitCharge("usage", "minute", "1")],
		candidate: [workload("agreement-a", [usage("minute", "20", "minute")])],
		allowances: kind === "allowance" ? [allowanceState("a", "10", "0")] : [],
		credits: kind === "credit" ? [creditState("c", "acquisition", 0)] : [],
		commitments: kind === "commitment" ? [commitmentState()] : [],
	});
}
function expectRejected(
	scenario: QuoteScenario,
	code = "INVALID_PRICING_INPUT",
) {
	const result = quoteScenario(rehashScenario(scenario));
	if (isQuoteVector(result)) throw new Error("invalid state was accepted");
	expect(result.code).toBe(code);
}
function monetary(value: CreditValue | CommitmentAmount | undefined) {
	if (value?.value.case !== "money") throw new Error("missing money");
	return value.value.value;
}

it("rejects negative source and recorded-basis values across source kinds", () => {
	const fields = [
		"allowance-included",
		"allowance-remaining",
		"allowance-used",
		"credit-face",
		"credit-remaining",
		"credit-used",
		"credit-remaining-basis",
		"credit-used-basis",
		"credit-acquisition",
		"commitment-amount",
		"commitment-remaining",
		"commitment-used",
	] as const;
	fc.assert(
		fc.property(
			fc.constantFrom(...fields),
			fc.integer({ min: 1, max: 1_000_000 }),
			(field, amount) => {
				const kind: Kind = field.startsWith("allowance")
					? "allowance"
					: field.startsWith("credit")
						? "credit"
						: "commitment";
				const scenario = scenarioFor(kind);
				const state = scenario.state;
				const allowance = state?.allowances[0];
				const credit = state?.credits[0];
				const commitment = state?.commitments[0];
				let target: { decimal: string } | undefined;
				switch (field) {
					case "allowance-included":
						target = allowance?.grant?.included;
						break;
					case "allowance-remaining":
						target = allowance?.remaining;
						break;
					case "allowance-used":
						target = allowance?.used;
						break;
					case "credit-face":
						target = monetary(credit?.grant?.faceValue);
						break;
					case "credit-remaining":
						target = monetary(credit?.remaining);
						break;
					case "credit-used":
						target = monetary(credit?.used);
						break;
					case "credit-remaining-basis":
						target = credit?.remainingBasis;
						break;
					case "credit-used-basis":
						target = credit?.usedBasis;
						break;
					case "credit-acquisition":
						target = credit?.grant?.economicBasis?.acquisitionAmount;
						break;
					case "commitment-amount":
						target = monetary(commitment?.commitment?.amount);
						break;
					case "commitment-remaining":
						target = monetary(commitment?.remaining);
						break;
					case "commitment-used":
						target = monetary(commitment?.used);
						break;
				}
				if (!target) throw new Error(`missing ${field}`);
				target.decimal = `-${amount}`;
				expectRejected(scenario);
			},
		),
		{ seed: 614486, numRuns: 360 },
	);
});

it.each([
	"credit",
	"commitment",
] as const)("rejects a negative %s balance", (kind) => {
	const scenario = scenarioFor(kind);
	const entry =
		kind === "credit"
			? scenario.state?.credits[0]?.remaining
			: scenario.state?.commitments[0]?.remaining;
	monetary(entry).decimal = "-10";
	expectRejected(scenario);
});

it("rejects an additional acquisition basis on a derived credit", () => {
	const scenario = scenarioFor("credit");
	const grant = scenario.state?.credits[0]?.grant;
	if (!grant) throw new Error("missing credit");
	grant.derivedFrom = "subscription";
	expectRejected(scenario);
});

it("allows a derived credit with zero acquisition and recorded basis", () => {
	const scenario = scenarioFor("credit");
	const credit = scenario.state?.credits[0];
	if (
		!credit?.grant?.economicBasis?.acquisitionAmount ||
		!credit.remainingBasis
	)
		throw new Error("missing credit");
	credit.grant.derivedFrom = "subscription";
	credit.grant.economicBasis.acquisitionAmount.decimal = "0";
	credit.remainingBasis.decimal = "0";
	expect(isQuoteVector(quoteScenario(rehashScenario(scenario)))).toBe(true);
});

it("rejects spending more credit basis than remains", () => {
	const scenario = scenarioFor("credit");
	const basis = scenario.state?.credits[0]?.remainingBasis;
	if (!basis) throw new Error("missing basis");
	basis.decimal = "1";
	expectRejected(scenario);
});

it("rejects recorded basis on a zero-basis credit", () => {
	const scenario = scenarioFor("credit");
	const credit = scenario.state?.credits[0];
	if (!credit?.grant?.economicBasis) throw new Error("missing credit");
	credit.grant.economicBasis.kind = "zero";
	credit.grant.economicBasis.acquisitionAmount = undefined;
	expectRejected(scenario);
});

it("rejects mismatched credit and commitment currencies", () => {
	for (const kind of ["credit", "commitment"] as const) {
		const scenario = scenarioFor(kind);
		const entry =
			kind === "credit"
				? scenario.state?.credits[0]?.used
				: scenario.state?.commitments[0]?.used;
		const value = monetary(entry);
		value.currency = "EUR";
		expectRejected(scenario, "CROSS_CURRENCY");
	}
	const scenario = scenarioFor("credit");
	const basis = scenario.state?.credits[0]?.remainingBasis;
	if (!basis) throw new Error("missing basis");
	basis.currency = "EUR";
	expectRejected(scenario, "CROSS_CURRENCY");
});

it("rejects a negative gross charge before applying a financial source", () => {
	const scenario = makeScenario({
		charges: [perUnitCharge("usage", "minute", "-1")],
		candidate: [workload("agreement-a", [usage("minute", "20", "minute")])],
		credits: [creditState("c", "acquisition", 0)],
	});
	expectRejected(scenario);
});

it.each([
	"fixed",
	"per-unit",
	"package",
	"graduated",
	"volume",
] as const)("rejects a negative %s rate even if another amount makes the total positive", (kind) => {
	const base = {
		id: "charge",
		selectors: {},
		fallback: false,
		invoiceBehavior: "itemized",
	};
	const usageBase = { dimension: "minute", timing: "arrears" };
	const tiered = {
		tiers: [{ from: "0", flatAmount: money("100"), unitAmount: money("-1") }],
	};
	const charge =
		kind === "fixed"
			? fixedCharge("charge", "-1")
			: kind === "per-unit"
				? perUnitCharge("charge", "minute", "-1")
				: kind === "package"
					? {
							base,
							usage: {
								...usageBase,
								package: { packageSize: "1", packageAmount: money("-1") },
							},
						}
					: { base, usage: { ...usageBase, [kind]: tiered } };
	const scenario = makeScenario({
		charges: [charge],
		candidate: [
			workload(
				"agreement-a",
				kind === "fixed" ? [] : [usage("minute", "20", "minute")],
			),
		],
	});
	expectRejected(scenario);
});

it("records monetary commitment consumption in its currency", () => {
	const scenario = scenarioFor("commitment");
	const current = quoteScenario(scenario);
	if (!isQuoteVector(current)) throw new Error("quote rejected");
	expect(current.consumption[0]?.quantity).toMatchObject({
		decimal: "20",
		unit: "USD",
	});
});

it("rejects source balances above their declared capacity", () => {
	fc.assert(
		fc.property(
			fc.constantFrom<Kind>("allowance", "credit", "commitment"),
			fc.integer({ min: 1, max: 10_000 }),
			(kind, excess) => {
				const scenario = scenarioFor(kind);
				if (kind === "allowance") {
					const remaining = scenario.state?.allowances[0]?.remaining;
					if (!remaining) throw new Error("missing allowance");
					remaining.decimal = String(1000 + excess);
				} else if (kind === "credit") {
					monetary(scenario.state?.credits[0]?.remaining).decimal = String(
						10 + excess,
					);
				} else {
					monetary(scenario.state?.commitments[0]?.remaining).decimal = String(
						100 + excess,
					);
				}
				expectRejected(scenario);
			},
		),
		{ seed: 614487, numRuns: 300 },
	);
});

it("accepts allowance and credit balances within declared rollover capacity", () => {
	const allowanceScenario = scenarioFor("allowance");
	const allowance = allowanceScenario.state?.allowances[0];
	if (!allowance?.grant?.rollover || !allowance.remaining)
		throw new Error("missing allowance");
	allowance.grant.rollover.max = "20";
	allowance.remaining.decimal = "1020";
	expect(isQuoteVector(quoteScenario(rehashScenario(allowanceScenario)))).toBe(
		true,
	);

	const creditScenario = scenarioFor("credit");
	const credit = creditScenario.state?.credits[0];
	if (
		!credit?.grant?.rollover ||
		!credit.grant.economicBasis ||
		!credit.remainingBasis
	)
		throw new Error("missing credit");
	credit.grant.rollover.max = "5";
	credit.grant.economicBasis.kind = "zero";
	credit.grant.economicBasis.acquisitionAmount = undefined;
	credit.remainingBasis.decimal = "0";
	monetary(credit.remaining).decimal = "15";
	const quote = quoteScenario(rehashScenario(creditScenario));
	if (!isQuoteVector(quote)) throw new Error("rollover credit rejected");
	expect(quote.incremental?.billed?.decimal).toBe("5");
});

it.each([
	"rollover",
	"true-up",
])("rejects unsupported %s commitment underuse", (underuse) => {
	const scenario = scenarioFor("commitment");
	const commitment = scenario.state?.commitments[0]?.commitment;
	if (!commitment) throw new Error("missing commitment");
	commitment.underuse = underuse;
	const result = quoteScenario(rehashScenario(scenario));
	if (isQuoteVector(result)) throw new Error("unsupported commitment accepted");
	expect(result.code).toBe("PRICING_MODEL_UNSUPPORTED");
});

it("rejects a derived acquisition even when no source is consumed", () => {
	const scenario = scenarioFor("credit");
	const credit = scenario.state?.credits[0];
	if (!credit?.grant || !credit.remainingBasis)
		throw new Error("missing credit");
	credit.grant.derivedFrom = "subscription";
	credit.remainingBasis.decimal = "0";
	scenario.candidate = [];
	expectRejected(scenario);
});

it("converts compatible allowance units before checking capacity", () => {
	const scenario = scenarioFor("allowance");
	const allowance = scenario.state?.allowances[0];
	if (!allowance?.grant?.included || !allowance.used || !allowance.remaining)
		throw new Error("missing allowance");
	allowance.grant.included.unit = "second";
	allowance.used.unit = "second";
	const quote = quoteScenario(rehashScenario(scenario));
	if (!isQuoteVector(quote)) throw new Error("compatible units rejected");
	expect(quote.incremental?.billed?.decimal).toBe("10");
	allowance.remaining.unit = "widget";
	expectRejected(scenario);
});

it.each([
	"allowance",
	"credit",
	"commitment",
] as const)("rejects %s state that reuses already-spent capacity", (kind) => {
	const scenario = scenarioFor(kind);
	if (kind === "allowance") {
		const used = scenario.state?.allowances[0]?.used;
		if (!used) throw new Error("missing allowance");
		used.decimal = "991";
	} else if (kind === "credit") {
		monetary(scenario.state?.credits[0]?.used).decimal = "1";
	} else {
		monetary(scenario.state?.commitments[0]?.used).decimal = "41";
	}
	expectRejected(scenario);
});

it.each([
	"acquisition",
	"face-value",
] as const)("rejects recorded basis above the %s basis", (kind) => {
	const scenario = scenarioFor("credit");
	const credit = scenario.state?.credits[0];
	if (
		!credit?.grant?.economicBasis ||
		!credit.usedBasis ||
		!credit.remainingBasis
	)
		throw new Error("missing credit");
	if (kind === "face-value") {
		credit.grant.economicBasis.kind = "face-value";
		credit.grant.economicBasis.acquisitionAmount = undefined;
		credit.remainingBasis.decimal = "10";
	}
	credit.usedBasis.decimal = "1";
	expectRejected(scenario);
});

it("rejects positive paid-credit rollover without attributable acquisition basis", () => {
	const scenario = scenarioFor("credit");
	const rollover = scenario.state?.credits[0]?.grant?.rollover;
	if (!rollover) throw new Error("missing rollover");
	rollover.max = "1";
	const result = quoteScenario(rehashScenario(scenario));
	if (isQuoteVector(result)) throw new Error("paid rollover accepted");
	expect(result.code).toBe("PRICING_MODEL_UNSUPPORTED");
});
