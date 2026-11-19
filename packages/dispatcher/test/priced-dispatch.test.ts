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
			reason: "no completely priced dispatch candidates",
			rejectedCandidates: [{ providerId: "stale", code: "STALE_OBSERVATION" }],
		});
	});
});
