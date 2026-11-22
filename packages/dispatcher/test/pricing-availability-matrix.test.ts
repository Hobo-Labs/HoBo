import { developerPricing, pricingUnavailable } from "@hobo/pricing";
import { describe, expect, it } from "vitest";
import {
	type PricedDispatchCandidate,
	decidePricedDispatch,
} from "../src/priced-dispatch.js";
import {
	dispatchQuoteScenario,
	staleDispatchQuoteScenario,
} from "./dispatcher-v2-fixtures.js";

type ModelState = "unavailable" | "partial" | "stale" | "zero" | "paid";
const states: readonly ModelState[] = [
	"unavailable",
	"partial",
	"stale",
	"zero",
	"paid",
];

function candidate(providerId: string, state: ModelState): PricedDispatchCandidate {
	if (state === "unavailable")
		return { providerId, pricing: pricingUnavailable("no model") };
	const scenario =
		state === "stale"
			? staleDispatchQuoteScenario(providerId)
			: dispatchQuoteScenario(providerId, state === "zero" ? "0" : "1");
	if (state === "partial") {
		if (scenario.options === undefined)
			throw new Error("fixture options missing");
		scenario.options.allowPartialFinancialState = true;
	}
	return {
		providerId,
		pricing: developerPricing(
			{
				modelId: `model-${providerId}`,
				revision: "1",
				tenantId: "tenant-a",
				providerId,
				providerAccountRef: providerId,
				productId: "runner",
			},
			scenario,
		),
	};
}

describe("pricing availability decision matrix", () => {
	it("matches the eligibility oracle for every pair and both input orders", () => {
		for (const a of states)
			for (const b of states) {
				const eligible = [
					{ id: "a", state: a },
					{ id: "b", state: b },
				]
					.filter(({ state }) => state === "zero" || state === "paid")
					.sort(
						(left, right) =>
							Number(left.state !== "zero") - Number(right.state !== "zero") ||
							left.id.localeCompare(right.id),
					);
				const candidates = [candidate("a", a), candidate("b", b)];
				const evaluate = (inputs: PricedDispatchCandidate[]) =>
					decidePricedDispatch({
						dispatchId: "matrix",
						category: "runner",
						candidates: inputs,
					});
				const decision = evaluate(candidates);
				expect(evaluate([...candidates].reverse()), `${a}/${b}`).toEqual(
					decision,
				);
				if (eligible.length === 0) {
					expect(decision.ok, `${a}/${b}`).toBe(false);
					continue;
				}
				if (!decision.ok) throw new Error(`expected a decision for ${a}/${b}`);
				expect(decision.selectedProvider, `${a}/${b}`).toBe(eligible[0]?.id);
				expect(decision.ranking).toHaveLength(eligible.length);
			}
	});
});
