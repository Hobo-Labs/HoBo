import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";

import { makeScenario, workload, usage, perUnitCharge } from "../../pricing/test/fixtures.js";
import {
	createDispatcherRegistry,
	decideDispatchV2,
} from "../src/index.js";
import { quoteScenario } from "@hobo/pricing";
import { isQuoteVector } from "@hobo/pricing";

describe("decideDispatchV2", () => {
	it("selects the provider with the lower incremental billed quote", () => {
		const cheap = makeScenario({
			charges: [perUnitCharge("usage", "minute", "0.01")],
			candidate: [workload("agreement-a", [usage("minute", "10", "minute")])],
		});
		const costly = makeScenario({
			charges: [perUnitCharge("usage", "minute", "0.05")],
			candidate: [workload("agreement-a", [usage("minute", "10", "minute")])],
		});
		for (const scenario of [cheap, costly]) {
			const quoted = quoteScenario(scenario);
			if (!isQuoteVector(quoted)) {
				throw new Error(`${quoted.code}: ${quoted.message}`);
			}
		}

		const registry = createDispatcherRegistry([
			{ id: "cheap", category: "runner", dimension: "runner.minutes" },
			{ id: "costly", category: "runner", dimension: "runner.minutes" },
		]);

		const decision = decideDispatchV2({
			dispatchId: "pricing-rank-1",
			category: "runner",
			registry,
			quotes: [
				{ providerId: "cheap", scenario: cheap },
				{ providerId: "costly", scenario: costly },
			],
		});

		assert.equal(decision.ok, true);
		if (!decision.ok) return;
		expect(decision.selectedProvider).toBe("cheap");
		expect(decision.ranking[0]?.incrementalBilled).toBe("0.1");
	});
});
