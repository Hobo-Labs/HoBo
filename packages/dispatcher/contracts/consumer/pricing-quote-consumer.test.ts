import { readFileSync } from "node:fs";
import {
	isJsonObject,
	type JsonValue,
	parseJson,
	parseQuoteScenario,
} from "@hobo/pricing";
import { describe, expect, it } from "vitest";
import { decideDispatchV2 } from "../../src/dispatcher-v2.js";

function object(value: JsonValue | undefined) {
	if (!isJsonObject(value))
		throw new Error("Pricing contract object is missing");
	return value;
}

const pact = object(
	parseJson(
		readFileSync(
			new URL(
				"../../../pricing/contracts/pacts/pricing-quote.pact.json",
				import.meta.url,
			),
			"utf8",
		),
	),
);
const interactions = pact.interactions;
if (!Array.isArray(interactions) || interactions.length === 0)
	throw new Error("Pricing contract interactions are missing");

describe("dispatcher pricing consumer contract", () => {
	for (const value of interactions) {
		const interaction = object(value);
		const contents = object(object(interaction.request).contents);
		const scenarioJson = contents.content;
		if (scenarioJson === undefined)
			throw new Error("Pricing scenario is missing");
		const scenario = parseQuoteScenario(scenarioJson);
		if (!scenario) throw new Error("Pricing scenario is invalid");
		const responses = interaction.response;
		if (!Array.isArray(responses) || responses.length !== 1)
			throw new Error("Pricing contract response is missing");
		const response = object(object(object(responses[0]).contents).content);
		const expectedBilled = object(object(response.incremental).billed);
		it(String(interaction.description), () => {
			const decision = decideDispatchV2({
				dispatchId: "pricing-contract",
				category: "runner",
				candidates: [{ providerId: "sandbox", scenario }],
			});
			expect(decision.ok).toBe(true);
			if (!decision.ok) throw new Error(decision.reason);
			expect(decision.selectedProvider).toBe("sandbox");
			expect(decision.ranking[0]?.incrementalBilled).toMatchObject(
				expectedBilled,
			);
		});
	}
});
