import fc from "fast-check";
import { expect, it } from "vitest";
import type { QuoteScenario } from "../src/_generated/pricing_pb.js";
import { quoteScenario } from "../src/quote.js";
import { isQuoteVector } from "../src/types.js";
import { makeScenario, perUnitCharge, usage, workload } from "./fixtures.js";

function latest(values: string[], unit = "minute"): QuoteScenario {
	return makeScenario({
		meters: [{ dimension: "minute", unit, aggregation: "latest" }],
		charges: [perUnitCharge("usage", "minute", "1")],
		candidate: values.map((value) =>
			workload("agreement-a", [usage("minute", value, unit)]),
		),
	});
}
function measurement(scenario: QuoteScenario, index: number) {
	const result = scenario.candidate[index]?.usage[0];
	if (!result?.quantity) throw new Error("missing measurement");
	return result;
}
function expectRejected(scenario: QuoteScenario) {
	const result = quoteScenario(scenario);
	if (isQuoteVector(result))
		throw new Error("ambiguous latest measurement accepted");
	expect(result.code).toBe("INVALID_PRICING_INPUT");
}

it("rejects different values at the same latest instant in either order", () => {
	for (const values of [
		["1", "100"],
		["100", "1"],
	]) {
		const scenario = latest(values);
		expectRejected(scenario);
		const prior = quoteScenario(scenario, {
			ratingAlgorithmVersion: "pricing-rating/v6",
		});
		if (!isQuoteVector(prior)) throw new Error("legacy quote rejected");
		expect(prior.incremental?.billed?.decimal).toBe(values[0]);
	}
});

it("recognizes equivalent fractional timestamp spellings as a tie", () => {
	const scenario = latest(["1", "100"]);
	measurement(scenario, 0).observedAt = "2026-01-01T00:00:00Z";
	measurement(scenario, 1).observedAt = "2026-01-01T00:00:00.000Z";
	expectRejected(scenario);
});

it("accepts equal quantities at the same instant after unit conversion", () => {
	const scenario = latest(["60", "1"], "second");
	const second = measurement(scenario, 1);
	if (!second.quantity) throw new Error("missing quantity");
	second.quantity.unit = "minute";
	const result = quoteScenario(scenario);
	if (!isQuoteVector(result)) throw new Error("equal measurements rejected");
	expect(result.incremental?.billed?.decimal).toBe("60");
});

it("accepts equivalent decimal values at the same instant", () => {
	const result = quoteScenario(latest(["1", "1.00"]));
	if (!isQuoteVector(result)) throw new Error("equal measurements rejected");
	expect(result.incremental?.billed?.decimal).toBe("1");
});

it("ignores conflicts at older instants when the latest value is unambiguous", () => {
	const scenario = latest(["1", "100", "7"]);
	measurement(scenario, 2).observedAt = "2026-01-01T00:00:01Z";
	const result = quoteScenario(scenario);
	if (!isQuoteVector(result)) throw new Error("latest value rejected");
	expect(result.incremental?.billed?.decimal).toBe("7");
});

it("rejects generated conflicting equal instants with equivalent fractions", () => {
	fc.assert(
		fc.property(
			fc.integer({ min: 0, max: 10_000 }),
			fc.integer({ min: 1, max: 10_000 }),
			fc.integer({ min: 1, max: 999_999 }),
			(a, delta, fraction) => {
				const scenario = latest([String(a), String(a + delta)]);
				const digits = String(fraction).padStart(6, "0");
				measurement(scenario, 0).observedAt = `2026-01-01T00:00:00.${digits}Z`;
				measurement(scenario, 1).observedAt = `2026-01-01T00:00:00.${digits}0Z`;
				expectRejected(scenario);
			},
		),
		{ seed: 614489, numRuns: 300 },
	);
});

it("rejects ambiguous latest measurements in the baseline", () => {
	const scenario = latest(["1", "100", "7"]);
	measurement(scenario, 2).observedAt = "2026-01-01T00:00:01Z";
	scenario.baseline = scenario.candidate.slice(0, 2);
	scenario.candidate = scenario.candidate.slice(2);
	expectRejected(scenario);
});
