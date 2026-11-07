import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decideDispatchV2 } from "../../src/dispatcher-v2.js";
import {
	dispatchQuoteScenario,
	staleDispatchQuoteScenario,
} from "../../test/dispatcher-v2-fixtures.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../pacts/dispatch_decision_v2.pact.json"),
		"utf8",
	),
);

describe("dispatcher v2 decision boundary consumer", () => {
	it("selects the minimum incremental billed quote", () => {
		const decision = decideDispatchV2({
			dispatchId: "dispatch-v2-pact",
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
		const interaction = pact.interactions[0];

		expect(decision).toMatchObject(interaction.response.body);
	});

	it("returns structured rejection when quote evidence is stale", () => {
		const decision = decideDispatchV2({
			dispatchId: "dispatch-v2-stale-pact",
			category: "runner",
			objective: "min-incremental-billed",
			candidates: [
				{ providerId: "stale", scenario: staleDispatchQuoteScenario("stale") },
			],
		});
		const interaction = pact.interactions[1];

		expect(decision).toMatchObject(interaction.response.body);
	});
});
