import { describe, expect, it } from "vitest";
import {
	DISPATCHER_V2_SCHEMA_VERSION,
	decideDispatchV2,
} from "../src/dispatcher-v2.js";
import {
	dispatchQuoteScenario,
	staleDispatchQuoteScenario,
} from "./dispatcher-v2-fixtures.js";

describe("dispatcher v2", () => {
	it("ranks exact incremental billed decimals and removes advisory allocation", () => {
		const decision = decideDispatchV2({
			dispatchId: "dispatch-v2",
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
			schema: DISPATCHER_V2_SCHEMA_VERSION,
			selectedProvider: "cheap",
			objective: "min-incremental-billed",
		});
		if (!decision.ok) throw new Error(decision.reason);
		expect(decision.ranking[0]?.incrementalBilled).toMatchObject({
			decimal: "0.9",
			currency: "USD",
		});
		expect(decision.ranking[0]?.quote).not.toHaveProperty("allocatedEffective");
		expect(decision.dispatchEvent.type).toBe("dispatch.Decided");
	});

	it("uses provider ID for deterministic zero-cost ties", () => {
		const decision = decideDispatchV2({
			dispatchId: "dispatch-v2-tie",
			category: "runner",
			candidates: [
				{ providerId: "zulu", scenario: dispatchQuoteScenario("zulu", "0") },
				{ providerId: "alpha", scenario: dispatchQuoteScenario("alpha", "0") },
			],
		});

		expect(decision.ok).toBe(true);
		if (!decision.ok) throw new Error(decision.reason);
		expect(decision.selectedProvider).toBe("alpha");
	});

	it("fails closed instead of treating rejected pricing as zero", () => {
		const decision = decideDispatchV2({
			dispatchId: "dispatch-v2-stale",
			category: "runner",
			candidates: [
				{ providerId: "stale", scenario: staleDispatchQuoteScenario("stale") },
			],
		});

		expect(decision).toMatchObject({
			ok: false,
			schema: DISPATCHER_V2_SCHEMA_VERSION,
			reason: "no completely priced dispatch candidates",
			rejectedCandidates: [{ providerId: "stale", code: "STALE_OBSERVATION" }],
		});
	});
});
