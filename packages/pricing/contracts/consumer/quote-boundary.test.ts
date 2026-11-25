import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	isJsonObject,
	type JsonValue,
	parseJson,
	quoteVectorToJson,
} from "../../src/json.js";
import { quoteScenarioJson } from "../../src/quote.js";
import { isQuoteVector } from "../../src/types.js";

function object(value: JsonValue | undefined): Record<string, JsonValue> {
	if (!isJsonObject(value)) throw new Error("PACT value is not an object");
	return value;
}

const here = dirname(fileURLToPath(import.meta.url));
const pact = object(
	parseJson(
		readFileSync(join(here, "../pacts/pricing-quote.pact.json"), "utf8"),
	),
);

describe("pricing quote consumer boundary", () => {
	it("meets the hand-authored QuoteVector expectation", () => {
		const interactions = pact.interactions;
		if (!Array.isArray(interactions))
			throw new Error("PACT interactions are missing");
		expect(interactions).toHaveLength(1);

		for (const value of interactions) {
			const interaction = object(value);
			const request = object(interaction.request);
			const response = object(interaction.response);
			expect(request.method).toBe("POST");
			expect(request.path).toBe("/pricing/v1/quote");
			const result = quoteScenarioJson(request.body);
			if (!isQuoteVector(result)) {
				throw new Error(`${result.code}: ${result.message}`);
			}
			expect(quoteVectorToJson(result)).toMatchObject(object(response.body));
		}
	});
});
