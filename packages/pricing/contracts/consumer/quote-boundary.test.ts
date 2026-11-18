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
			expect(interaction.type).toBe("Synchronous/Messages");
			const request = object(object(interaction.request).contents);
			const responses = interaction.response;
			if (!Array.isArray(responses) || responses.length !== 1)
				throw new Error("PACT response is missing");
			const response = object(object(responses[0]).contents);
			expect(request.contentType).toBe("application/json");
			expect(response.contentType).toBe("application/json");
			const result = quoteScenarioJson(request.content);
			if (!isQuoteVector(result)) {
				throw new Error(`${result.code}: ${result.message}`);
			}
			expect(quoteVectorToJson(result)).toMatchObject(object(response.content));
		}
	});
});
