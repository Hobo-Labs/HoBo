import fc from "fast-check";
import { expect, it } from "vitest";
import { quoteScenario } from "../src/quote.js";
import { isQuoteVector } from "../src/types.js";
import {
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

function example(completeness: string, allowPartial: boolean) {
	const scenario = makeScenario({
		charges: [perUnitCharge("usage", "minute", "1")],
		candidate: [workload("agreement-a", [usage("minute", "1", "minute")])],
	});
	if (!scenario.state || !scenario.options)
		throw new Error("missing scenario state");
	scenario.state.completeness = completeness;
	scenario.options.allowPartialFinancialState = allowPartial;
	return rehashScenario(scenario);
}

it.each([
	false,
	true,
])("keeps a complete quote eligible when allowPartial is %s", (allowPartial) => {
	const result = quoteScenario(example("complete", allowPartial));
	if (!isQuoteVector(result)) throw new Error("complete quote rejected");
	expect(result.eligibility?.eligible).toBe(true);
});

it("allows partial showback but marks it ineligible for automatic selection", () => {
	const scenario = example("partial", true);
	const result = quoteScenario(scenario);
	if (!isQuoteVector(result)) throw new Error("partial showback rejected");
	expect(result.incremental?.billed?.decimal).toBe("1");
	expect(result.eligibility).toMatchObject({
		eligible: false,
		rejectedCandidates: [
			{ candidateRef: "agreement-a", code: "INCOMPLETE_FINANCIAL_STATE" },
		],
	});
	expect(result.assumptions).toContain(
		"financial state is partial; quote is informational only",
	);
	const old = quoteScenario(scenario, {
		ratingAlgorithmVersion: "pricing-rating/v8",
	});
	if (!isQuoteVector(old)) throw new Error("legacy quote rejected");
	expect(old.eligibility?.eligible).toBe(true);
});

it("rejects partial state when showback is not enabled", () => {
	const result = quoteScenario(example("partial", false));
	if (isQuoteVector(result)) throw new Error("partial state accepted");
	expect(result.code).toBe("INCOMPLETE_FINANCIAL_STATE");
});

it("rejects unknown completeness values even when partial showback is enabled", () => {
	fc.assert(
		fc.property(
			fc
				.string({ maxLength: 12 })
				.filter((s) => s !== "complete" && s !== "partial"),
			(status) => {
				const result = quoteScenario(example(status, true));
				if (isQuoteVector(result))
					throw new Error("unknown completeness accepted");
				expect(result.code).toBe("INVALID_PRICING_INPUT");
			},
		),
		{ seed: 614492, numRuns: 200 },
	);
});
