import { describe, expect, it } from "vitest";
import { quoteScenario } from "../src/quote.js";
import {
	fixedCharge,
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

function scenario(interval: string, horizon: string) {
	const input = makeScenario({
		charges: [perUnitCharge("runtime", "minute", "1")],
		candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
	});
	const period = input.state?.agreements[0]?.billingPeriod;
	if (!period) throw new Error("missing billing period fixture");
	period.interval = interval;
	input.horizon = horizon;
	rehashScenario(input);
	return input;
}

describe("billing-period bounds", () => {
	it.each([
		["daily", "2026-01-01T23:59:59Z"],
		["weekly", "2026-01-07T23:59:59Z"],
		["monthly", "2026-01-31T23:59:59Z"],
		["yearly", "2026-12-31T23:59:59Z"],
	] as const)("rates a horizon contained within one %s period", (interval, horizon) => {
		expect(quoteScenario(scenario(interval, horizon))).toMatchObject({
			$typeName: "hobo.pricing.v1.QuoteVector",
			incremental: { billed: { decimal: "4", currency: "USD" } },
		});
	});

	it.each([
		["daily", "2026-01-02T00:00:00Z"],
		["weekly", "2026-01-08T00:00:00Z"],
		["monthly", "2026-02-01T00:00:00Z"],
		["yearly", "2027-01-01T00:00:00Z"],
	] as const)("rejects a horizon reaching the next %s period", (interval, horizon) => {
		expect(quoteScenario(scenario(interval, horizon))).toMatchObject({
			code: "PRICING_MODEL_UNSUPPORTED",
		});
	});

	it.each([
		["monthly", "2025-12-31T00:00:00Z"],
		["yearly", "2024-02-29T00:00:00Z"],
	] as const)("rejects an ambiguous %s calendar anchor", (interval, anchor) => {
		const input = scenario(interval, "2026-01-03T00:00:00Z");
		const period = input.state?.agreements[0]?.billingPeriod;
		if (!period) throw new Error("missing billing period fixture");
		period.anchor = anchor;
		rehashScenario(input);
		expect(quoteScenario(input)).toMatchObject({
			code: "PRICING_MODEL_UNSUPPORTED",
		});
	});

	it("rejects a horizon before the billing anchor", () => {
		const input = scenario("monthly", "2026-01-03T00:00:00Z");
		const period = input.state?.agreements[0]?.billingPeriod;
		if (!period) throw new Error("missing billing period fixture");
		period.anchor = "2026-01-02T00:00:00Z";
		rehashScenario(input);
		expect(quoteScenario(input)).toMatchObject({
			code: "PRICING_MODEL_UNSUPPORTED",
		});
	});

	it("honors a monthly anchor's day and time rather than calendar-month starts", () => {
		const input = scenario("monthly", "2026-02-15T11:59:59Z");
		const period = input.state?.agreements[0]?.billingPeriod;
		if (!period) throw new Error("missing billing period fixture");
		period.anchor = "2026-01-15T12:00:00Z";
		input.at = "2026-02-14T00:00:00Z";
		rehashScenario(input);
		expect(quoteScenario(input).$typeName).toBe("hobo.pricing.v1.QuoteVector");
		input.horizon = "2026-02-15T12:00:00Z";
		expect(quoteScenario(input)).toMatchObject({
			code: "PRICING_MODEL_UNSUPPORTED",
		});
	});

	it("checks each monthly boundary in a bounded calendar year", () => {
		const input = scenario("monthly", "2026-01-16T00:00:00Z");
		const period = input.state?.agreements[0]?.billingPeriod;
		if (!period) throw new Error("missing billing period fixture");
		period.anchor = "2026-01-15T12:00:00Z";
		rehashScenario(input);
		for (let month = 0; month < 11; month++) {
			const start = Date.UTC(2026, month, 15, 12);
			const next = Date.UTC(2026, month + 1, 15, 12);
			input.at = new Date(start).toISOString();
			input.horizon = new Date(next - 1).toISOString();
			expect(quoteScenario(input).$typeName).toBe(
				"hobo.pricing.v1.QuoteVector",
			);
			input.horizon = new Date(next).toISOString();
			expect(quoteScenario(input)).toMatchObject({
				code: "PRICING_MODEL_UNSUPPORTED",
			});
		}
	});

	it("supports a yearly anchor on January 31", () => {
		const input = scenario("yearly", "2026-12-31T23:59:59Z");
		const period = input.state?.agreements[0]?.billingPeriod;
		if (!period) throw new Error("missing billing period fixture");
		period.anchor = "2025-01-31T00:00:00Z";
		input.at = "2026-02-01T00:00:00Z";
		rehashScenario(input);
		expect(quoteScenario(input).$typeName).toBe("hobo.pricing.v1.QuoteVector");
	});

	it.each([
		"daily",
		"weekly",
		"yearly",
		"unknown",
	])("rejects %s fixed cadence on a monthly agreement", (cadence) => {
		const input = makeScenario({
			charges: [
				perUnitCharge("runtime", "minute", "1"),
				fixedCharge("subscription", "10"),
			],
			candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
		});
		const fixed = input.catalog?.rateCards[0]?.charges[1];
		if (fixed?.variant.case !== "fixed")
			throw new Error("missing fixed charge fixture");
		fixed.variant.value.cadence = cadence;
		rehashScenario(input);
		expect(quoteScenario(input)).toMatchObject({
			code: "PRICING_MODEL_UNSUPPORTED",
		});
	});

	it.each([
		"monthly",
		"once",
	])("accepts %s fixed cadence on a monthly agreement", (cadence) => {
		const input = makeScenario({
			charges: [
				perUnitCharge("runtime", "minute", "1"),
				fixedCharge("subscription", "10"),
			],
			candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
		});
		const fixed = input.catalog?.rateCards[0]?.charges[1];
		if (fixed?.variant.case !== "fixed")
			throw new Error("missing fixed charge fixture");
		fixed.variant.value.cadence = cadence;
		rehashScenario(input);
		expect(quoteScenario(input).$typeName).toBe("hobo.pricing.v1.QuoteVector");
	});

	it("ignores an inactive agreement that is not part of the rated workloads", () => {
		const input = scenario("monthly", "2026-01-03T00:00:00Z");
		const state = input.state;
		const first = state?.agreements[0];
		if (!state || !first?.billingPeriod)
			throw new Error("missing agreement fixture");
		state.agreements.push({
			...first,
			id: "inactive",
			status: "cancelled",
			billingPeriod: { ...first.billingPeriod, anchor: "2025-12-31T00:00:00Z" },
		});
		rehashScenario(input);
		expect(quoteScenario(input).$typeName).toBe("hobo.pricing.v1.QuoteVector");
	});
});
