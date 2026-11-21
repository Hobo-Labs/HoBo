import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	parseQuoteScenario,
	quoteVectorToJson,
	stableJson,
} from "../src/json.js";
import { quoteScenario } from "../src/quote.js";
import { isQuoteVector } from "../src/types.js";

const baselines = [
	"golden-replay-baseline.json",
	"golden-replay-v2.json",
	"golden-replay-v3.json",
	"golden-replay-v4.json",
	"golden-replay-v5.json",
	"golden-replay-v6.json",
].map((name) =>
	JSON.parse(
		readFileSync(join(import.meta.dirname, "../corpus", name), "utf8"),
	),
);

describe("pricing golden replay corpus", () => {
	it.each(
		baselines,
	)("replays every pinned scenario to its exact quote and hash", (baseline) => {
		expect(baseline.schema).toBe("hobo.pricing.golden-replay-corpus/v1");
		expect(baseline.entries.length).toBeGreaterThan(0);

		for (const entry of baseline.entries) {
			const scenario = parseQuoteScenario(entry.scenario);
			if (scenario === undefined) {
				throw new Error(`invalid pinned scenario: ${entry.key}`);
			}
			const result = quoteScenario(scenario, {
				ratingAlgorithmVersion: entry.quote.ratingAlgorithmVersion,
			});
			if (!isQuoteVector(result)) {
				throw new Error(`${entry.key}: ${result.code}: ${result.message}`);
			}

			const quote = quoteVectorToJson(result);
			expect(stableJson(quote), entry.key).toBe(stableJson(entry.quote));
			expect(result.quoteHash, entry.key).toBe(entry.quote.quoteHash);
		}
	});
});
