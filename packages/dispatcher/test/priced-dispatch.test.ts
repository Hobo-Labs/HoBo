import { developerPricing, pricingUnavailable } from "@hobo/pricing";
import { describe, expect, it } from "vitest";
import {
	decidePricedDispatch,
	PRICED_DISPATCH_SCHEMA,
} from "../src/priced-dispatch.js";
import {
	dispatchQuoteScenario,
	staleDispatchQuoteScenario,
	zeroCostCommitmentDispatchScenario,
} from "./priced-dispatch-fixtures.js";

describe("priced dispatcher", () => {
	it("ranks exact incremental billed decimals and removes advisory allocation", () => {
		const decision = decidePricedDispatch({
			dispatchId: "priced-dispatch",
			category: "runner",
			objective: "min-incremental-billed",
			candidates: [
				{
					providerId: "expensive",
					scenario: dispatchQuoteScenario("expensive", "0.1"),
				},
				{
					providerId: "cheap",
					scenario: dispatchQuoteScenario("cheap", "0.09"),
				},
			],
		});

		expect(decision).toMatchObject({
			ok: true,
			schema: PRICED_DISPATCH_SCHEMA,
			budget: { evaluation: "not-evaluated", reservation: "not-created" },
			selectedProvider: "cheap",
			objective: "min-incremental-billed",
		});
		if (!decision.ok) throw new Error(decision.reason);
		expect(decision.ranking[0]?.incrementalBilled).toMatchObject({
			decimal: "0.9",
			currency: "USD",
		});
		expect(decision.ranking[0]?.quote).not.toHaveProperty("allocatedEffective");
		expect(decision.dispatchEvent.type).toBe("dispatch.Priced");
		expect(decision.dispatchEvent.data.ranking[0]).toEqual({
			providerId: "cheap",
			rank: 1,
			incrementalBilled: { decimal: "0.9", currency: "USD" },
			quoteHash: decision.ranking[0]?.quote.quoteHash,
		});
		expect(decision.dispatchEvent.data.budget).toEqual(decision.budget);
	});

	it("uses sooner projected waste expiry for zero-cost ties (§10.11)", () => {
		const decision = decidePricedDispatch({
			dispatchId: "priced-dispatch-tie",
			category: "runner",
			candidates: [
				{
					providerId: "provider-later",
					scenario: zeroCostCommitmentDispatchScenario(
						"provider-later",
						"2026-01-31T23:59:59Z",
					),
				},
				{
					providerId: "provider-sooner",
					scenario: zeroCostCommitmentDispatchScenario(
						"provider-sooner",
						"2026-01-15T00:00:00Z",
					),
				},
			],
		});

		expect(decision.ok).toBe(true);
		if (!decision.ok) throw new Error(decision.reason);
		expect(decision.selectedProvider).toBe("provider-sooner");
	});

	it("fails closed instead of treating rejected pricing as zero", () => {
		const decision = decidePricedDispatch({
			dispatchId: "priced-dispatch-stale",
			category: "runner",
			candidates: [
				{ providerId: "stale", scenario: staleDispatchQuoteScenario("stale") },
			],
		});

		expect(decision).toMatchObject({
			ok: false,
			schema: PRICED_DISPATCH_SCHEMA,
			budget: { evaluation: "not-evaluated", reservation: "not-created" },
			reason: "no completely priced dispatch candidates",
			rejectedCandidates: [{ providerId: "stale", code: "STALE_OBSERVATION" }],
		});
	});

	it("excludes an explicitly unpriced target and records a supplied model on the winner", () => {
		const request = {
			dispatchId: "dispatch-supplied",
			category: "runner" as const,
			candidates: [
				{
					providerId: "unpriced",
					pricing: pricingUnavailable("provider supplies no price"),
				},
				{
					providerId: "priced",
					pricing: developerPricing(
						{
							modelId: "my-contract",
							revision: "2",
							tenantId: "tenant-a",
							providerId: "priced",
							providerAccountRef: "priced",
							productId: "runner",
						},
						dispatchQuoteScenario("priced", "0.1"),
					),
				},
			],
		};
		const decision = decidePricedDispatch(request);
		expect(decision).toMatchObject({
			ok: true,
			selectedProvider: "priced",
			rejectedCandidates: [
				{ providerId: "unpriced", code: "PRICING_MODEL_UNAVAILABLE" },
			],
			ranking: [
				{
					pricingModel: {
						source: "developer-supplied",
						modelId: "my-contract",
						revision: "2",
					},
				},
			],
		});
		if (!decision.ok) throw new Error(decision.reason);
		expect(decision.dispatchEvent.data.ranking).toEqual(decision.ranking);
		expect(decidePricedDispatch(request)).toEqual(decision);
	});

	it("refuses the whole dispatch when every target is unpriced", () => {
		expect(
			decidePricedDispatch({
				dispatchId: "unpriced-only",
				category: "runner",
				candidates: [
					{
						providerId: "unpriced-target",
						pricing: pricingUnavailable("no model"),
					},
				],
			}),
		).toMatchObject({
			ok: false,
			ranking: [],
			rejectedCandidates: [{ code: "PRICING_MODEL_UNAVAILABLE" }],
		});
	});

	it("does not rank a legacy scenario that opts into partial financial state", () => {
		const scenario = dispatchQuoteScenario("partial", "0.01");
		if (scenario.options === undefined)
			throw new Error("fixture options missing");
		scenario.options.allowPartialFinancialState = true;
		expect(
			decidePricedDispatch({
				dispatchId: "partial",
				category: "runner",
				candidates: [{ providerId: "partial", scenario }],
			}),
		).toMatchObject({
			ok: false,
			rejectedCandidates: [{ code: "INCOMPLETE_FINANCIAL_STATE" }],
		});
	});
});
