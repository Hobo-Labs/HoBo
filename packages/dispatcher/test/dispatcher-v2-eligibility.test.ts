import { isQuoteVector, QuoteEngine, stateHashOf } from "@hobo/pricing";
import { expect, it } from "vitest";
import { decideDispatchV2 } from "../src/dispatcher-v2.js";
import { hasDispatchEligibility } from "../src/quote-admission.js";
import { dispatchQuoteScenario } from "./dispatcher-v2-fixtures.js";

it("chooses a complete candidate over a cheaper partial showback", () => {
	const partial = dispatchQuoteScenario("partial", "0.01");
	if (!partial.state || !partial.options) throw new Error("missing state");
	partial.state.completeness = "partial";
	partial.options.allowPartialFinancialState = true;
	partial.state.stateHash = stateHashOf(partial.state);
	const result = decideDispatchV2({
		dispatchId: "partial",
		category: "runner",
		candidates: [
			{ providerId: "partial", scenario: partial },
			{
				providerId: "complete",
				scenario: dispatchQuoteScenario("complete", "1"),
			},
		],
	});
	if (!result.ok) throw new Error(result.reason);
	expect(result.selectedProvider).toBe("complete");
	expect(result.rejectedCandidates).toContainEqual(
		expect.objectContaining({
			providerId: "partial",
			code: "INCOMPLETE_FINANCIAL_STATE",
		}),
	);
});

it("fails closed when every candidate is only a partial showback", () => {
	const partial = dispatchQuoteScenario("partial", "0.01");
	if (!partial.state || !partial.options) throw new Error("missing state");
	partial.state.completeness = "partial";
	partial.options.allowPartialFinancialState = true;
	partial.state.stateHash = stateHashOf(partial.state);
	const result = decideDispatchV2({
		dispatchId: "partial-only",
		category: "runner",
		candidates: [{ providerId: "partial", scenario: partial }],
	});
	expect(result.ok).toBe(false);
	expect(result.rejectedCandidates).toContainEqual(
		expect.objectContaining({
			providerId: "partial",
			code: "INCOMPLETE_FINANCIAL_STATE",
		}),
	);
});

it("fails closed when an otherwise valid quote lacks eligibility metadata", () => {
	const scenario = dispatchQuoteScenario("missing-eligibility", "0.01");
	const quote = QuoteEngine.quote(scenario);
	if (!isQuoteVector(quote)) throw new Error("complete quote rejected");
	expect(hasDispatchEligibility(quote)).toBe(true);
	quote.eligibility = undefined;
	expect(hasDispatchEligibility(quote)).toBe(false);
});
