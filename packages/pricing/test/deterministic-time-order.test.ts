import { describe, expect, it } from "vitest";
import { quoteScenario } from "../src/quote.js";
import {
	creditState,
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

describe("deterministic pricing time order", () => {
	it("consumes the earlier expiry before a later fractional-second expiry", () => {
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "1")],
			candidate: [workload("agreement-a", [usage("minute", "10", "minute")])],
			credits: [
				creditState("Z-early", "zero", 0),
				creditState("a-later", "acquisition", 0),
			],
		});
		const early = scenario.state?.credits[0]?.grant?.effective;
		const later = scenario.state?.credits[1]?.grant?.effective;
		if (!early || !later) throw new Error("missing credit fixture");
		early.end = "2027-01-01T00:00:00Z";
		later.end = "2027-01-01T00:00:00.5Z";
		rehashScenario(scenario);
		expect(quoteScenario(scenario)).toMatchObject({
			$typeName: "hobo.pricing.v1.QuoteVector",
			consumption: [{ sourceId: "Z-early" }],
			incremental: { effective: { decimal: "0", currency: "USD" } },
		});
	});

	it("selects the later effective rate schedule across different UTC precisions", () => {
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "1")],
			candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
		});
		const card = scenario.catalog?.rateCards[0];
		const agreement = scenario.state?.agreements[0];
		const schedule = agreement?.rateSchedule[0];
		if (!card || !agreement || !schedule?.effective || !scenario.catalog)
			throw new Error("missing schedule fixture");
		const later = structuredClone(card);
		later.id = "card-v2";
		const charge = later.charges[0];
		if (
			charge?.variant.case !== "usage" ||
			charge.variant.value.price.case !== "perUnit"
		)
			throw new Error("missing usage charge fixture");
		charge.variant.value.price.value.decimal = "10";
		scenario.catalog.rateCards.push(later);
		schedule.effective.start = "2025-01-01T00:00:00Z";
		agreement.rateSchedule.push({
			...schedule,
			rateCardId: "card-v2",
			effective: { ...schedule.effective, start: "2025-01-01T00:00:00.5Z" },
		});
		rehashScenario(scenario);
		expect(quoteScenario(scenario)).toMatchObject({
			$typeName: "hobo.pricing.v1.QuoteVector",
			incremental: { billed: { decimal: "40", currency: "USD" } },
		});
	});

	it.each([
		false,
		true,
	])("rejects different rate cards starting at the same instant in either order (reverse=%s)", (reverse) => {
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "1")],
			candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
		});
		const card = scenario.catalog?.rateCards[0];
		const agreement = scenario.state?.agreements[0];
		const schedule = agreement?.rateSchedule[0];
		if (!card || !agreement || !schedule?.effective || !scenario.catalog)
			throw new Error("missing schedule fixture");
		const other = structuredClone(card);
		other.id = "card-v2";
		scenario.catalog.rateCards.push(other);
		schedule.effective.start = "2025-01-01T00:00:00Z";
		agreement.rateSchedule.push({
			...schedule,
			rateCardId: "card-v2",
			effective: { ...schedule.effective, start: "2025-01-01T00:00:00.0Z" },
		});
		if (reverse) agreement.rateSchedule.reverse();
		rehashScenario(scenario);
		expect(quoteScenario(scenario)).toMatchObject({
			code: "PRICING_MODEL_UNSUPPORTED",
		});
	});

	it("uses the chronologically latest measurement", () => {
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "1")],
			meters: [{ dimension: "minute", unit: "minute", aggregation: "latest" }],
			candidate: [
				workload("agreement-a", [
					usage("minute", "9", "minute"),
					usage("minute", "2", "minute"),
				]),
			],
		});
		const first = scenario.candidate[0]?.usage[0];
		const second = scenario.candidate[0]?.usage[1];
		if (!first || !second) throw new Error("missing measurement fixture");
		first.observedAt = "2026-01-01T00:00:00Z";
		second.observedAt = "2026-01-01T00:00:00.1Z";
		expect(quoteScenario(scenario)).toMatchObject({
			$typeName: "hobo.pricing.v1.QuoteVector",
			incremental: { billed: { decimal: "2", currency: "USD" } },
		});
	});

	it.each([
		false,
		true,
	])("rejects conflicting latest observations at the same instant in either order (reverse=%s)", (reverse) => {
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "1")],
			meters: [{ dimension: "minute", unit: "minute", aggregation: "latest" }],
			candidate: [
				workload("agreement-a", [
					usage("minute", "9", "minute"),
					usage("minute", "2", "minute"),
				]),
			],
		});
		const measurements = scenario.candidate[0]?.usage;
		if (!measurements?.[0] || !measurements[1])
			throw new Error("missing measurement fixture");
		measurements[0].observedAt = "2026-01-01T00:00:00Z";
		measurements[1].observedAt = "2026-01-01T00:00:00.0Z";
		if (reverse) measurements.reverse();
		expect(quoteScenario(scenario)).toMatchObject({
			code: "PRICING_MODEL_UNSUPPORTED",
		});
	});

	it("accepts equivalent latest observations at the same instant", () => {
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "1")],
			meters: [{ dimension: "minute", unit: "minute", aggregation: "latest" }],
			candidate: [
				workload("agreement-a", [
					usage("minute", "2", "minute"),
					usage("minute", "2.0", "minute"),
				]),
			],
		});
		const measurements = scenario.candidate[0]?.usage;
		if (!measurements?.[0] || !measurements[1])
			throw new Error("missing measurement fixture");
		measurements[0].observedAt = "2026-01-01T00:00:00Z";
		measurements[1].observedAt = "2026-01-01T00:00:00.000Z";
		expect(quoteScenario(scenario)).toMatchObject({
			$typeName: "hobo.pricing.v1.QuoteVector",
			incremental: { billed: { decimal: "2", currency: "USD" } },
		});
	});

	it.each([
		"scenario",
		"rate-card",
		"observation",
		"agreement-evidence",
	] as const)("rejects sub-millisecond precision in %s", (field) => {
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "1")],
			candidate: [workload("agreement-a", [usage("minute", "1", "minute")])],
		});
		const value = "2026-01-01T00:00:00.0001Z";
		if (field === "scenario") scenario.at = value;
		if (field === "rate-card") {
			const effective = scenario.catalog?.rateCards[0]?.effective;
			if (!effective) throw new Error("missing rate card fixture");
			effective.start = value;
		}
		if (field === "observation") {
			const observation = scenario.state?.observations[0];
			if (!observation) throw new Error("missing observation fixture");
			observation.observedAt = value;
		}
		if (field === "agreement-evidence") {
			const evidence = scenario.state?.agreements[0]?.evidence;
			if (!evidence) throw new Error("missing evidence fixture");
			evidence.observedAt = value;
		}
		rehashScenario(scenario);
		expect(quoteScenario(scenario)).toMatchObject({
			code: "INVALID_PRICING_INPUT",
		});
	});

	it.each([
		"2026-01-01T00:00:00.0001Z",
		"2026-02-31T00:00:00Z",
		"not-a-time",
	])("rejects an unsupported or invalid measurement timestamp %s", (observedAt) => {
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "1")],
			meters: [{ dimension: "minute", unit: "minute", aggregation: "latest" }],
			candidate: [workload("agreement-a", [usage("minute", "1", "minute")])],
		});
		const measurement = scenario.candidate[0]?.usage[0];
		if (!measurement) throw new Error("missing measurement fixture");
		measurement.observedAt = observedAt;
		expect(quoteScenario(scenario)).toMatchObject({
			code: "INVALID_PRICING_INPUT",
		});
	});
});
