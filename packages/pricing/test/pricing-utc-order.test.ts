import { clone, create } from "@bufbuild/protobuf";
import fc from "fast-check";
import { expect, it } from "vitest";
import {
	EffectiveIntervalSchema,
	RateCardSchema,
	RateScheduleEntrySchema,
} from "../src/_generated/pricing_pb.js";
import { resolveRateCard } from "../src/catalog.js";
import { quoteScenario } from "../src/quote.js";
import { intervalCovers, parseUtc } from "../src/state.js";
import { utcPricingTimeOrder } from "../src/time-order.js";
import { isQuoteVector } from "../src/types.js";
import {
	creditState,
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

it("orders equal-priority credits by the actual expiry instant", () => {
	const scenario = makeScenario({
		charges: [perUnitCharge("usage", "minute", "1")],
		candidate: [workload("agreement-a", [usage("minute", "10", "minute")])],
		credits: [
			creditState("z-early", "acquisition", 0),
			creditState("a-late", "zero", 0),
		],
	});
	const early = scenario.state?.credits.find(
		(credit) => credit.grant?.id === "z-early",
	)?.grant?.effective;
	const late = scenario.state?.credits.find(
		(credit) => credit.grant?.id === "a-late",
	)?.grant?.effective;
	if (!early || !late) throw new Error("missing credit interval");
	early.end = "2027-01-01T00:00:00Z";
	late.end = "2027-01-01T00:00:00.5Z";
	rehashScenario(scenario);
	const current = quoteScenario(scenario);
	if (!isQuoteVector(current)) throw new Error("quote rejected");
	expect(current.consumption.map((item) => item.sourceId)).toEqual(["z-early"]);
	expect(current.incremental?.effective?.decimal).toBe("9");
});

it("rejects future millisecond state, sub-millisecond timestamps and impossible calendar dates", () => {
	for (const [asOf, code] of [
		["2026-01-01T00:00:00.001Z", "STALE_OBSERVATION"],
		["2026-01-01T00:00:00.0001Z", "INVALID_PRICING_INPUT"],
	] as const) {
		const scenario = makeScenario({
			charges: [perUnitCharge("usage", "minute", "1")],
			candidate: [workload("agreement-a", [usage("minute", "1", "minute")])],
		});
		if (!scenario.state) throw new Error("missing financial state");
		scenario.state.asOf = asOf;
		rehashScenario(scenario);
		const current = quoteScenario(scenario);
		if (isQuoteVector(current)) throw new Error("future state was accepted");
		expect(current.code).toBe(code);
	}
	expect(() => parseUtc("2026-02-31T00:00:00Z", "test")).toThrow(/calendar/);
	expect(() => parseUtc("2024-02-29T00:00:00Z", "test")).not.toThrow();
});

it("rejects an observation that expires a fraction before the horizon", () => {
	const scenario = makeScenario({
		charges: [perUnitCharge("usage", "minute", "1")],
		candidate: [workload("agreement-a", [usage("minute", "1", "minute")])],
	});
	const observation = scenario.state?.observations[0];
	if (!observation) throw new Error("missing observation");
	scenario.horizon = "2026-01-31T23:59:59.002Z";
	observation.validUntil = "2026-01-31T23:59:59.001Z";
	rehashScenario(scenario);
	const current = quoteScenario(scenario);
	if (isQuoteVector(current)) throw new Error("stale observation accepted");
	expect(current.code).toBe("STALE_OBSERVATION");
});

it("rates the latest observation by instant instead of timestamp text", () => {
	const scenario = makeScenario({
		meters: [{ dimension: "minute", unit: "minute", aggregation: "latest" }],
		charges: [perUnitCharge("usage", "minute", "1")],
		candidate: [
			workload("agreement-a", [
				usage("minute", "1", "minute"),
				usage("minute", "2", "minute"),
			]),
		],
	});
	const measurements = scenario.candidate[0]?.usage;
	if (!measurements?.[0] || !measurements[1])
		throw new Error("missing measurements");
	measurements[0].observedAt = "2025-12-31T23:59:59Z";
	measurements[1].observedAt = "2025-12-31T23:59:59.5Z";
	const current = quoteScenario(scenario);
	if (!isQuoteVector(current)) throw new Error("quote rejected");
	expect(current.incremental?.billed?.decimal).toBe("2");
});

it("rejects an invalid timestamp even for a single latest observation", () => {
	const scenario = makeScenario({
		meters: [{ dimension: "minute", unit: "minute", aggregation: "latest" }],
		charges: [perUnitCharge("usage", "minute", "1")],
		candidate: [workload("agreement-a", [usage("minute", "1", "minute")])],
	});
	const measurement = scenario.candidate[0]?.usage[0];
	if (!measurement) throw new Error("missing measurement");
	measurement.observedAt = "2026-02-31T00:00:00Z";
	const current = quoteScenario(scenario);
	if (isQuoteVector(current)) throw new Error("invalid timestamp accepted");
	expect(current.code).toBe("INVALID_PRICING_INPUT");
});

it("chooses the newest effective rate-card start by instant", () => {
	const scenario = makeScenario({
		charges: [perUnitCharge("usage", "minute", "1")],
	});
	const catalog = scenario.catalog;
	const agreement = scenario.state?.agreements[0];
	const original = catalog?.rateCards[0];
	if (!catalog || !agreement || !original)
		throw new Error("missing rate-card fixture");
	const later = clone(RateCardSchema, original);
	later.id = "later-card";
	catalog.rateCards.push(later);
	agreement.rateSchedule = [
		create(RateScheduleEntrySchema, {
			rateCardId: original.id,
			effective: { start: "2025-01-01T00:00:00Z", end: "2027-01-01T00:00:00Z" },
		}),
		create(RateScheduleEntrySchema, {
			rateCardId: later.id,
			effective: {
				start: "2025-01-01T00:00:00.5Z",
				end: "2027-01-01T00:00:00Z",
			},
		}),
	];
	expect(
		resolveRateCard(catalog, agreement, scenario.at, scenario.horizon).id,
	).toBe("later-card");
});

it("compares millisecond fractions against an integer oracle and refuses finer precision", () => {
	const digits = fc
		.array(fc.integer({ min: 0, max: 9 }), { maxLength: 3 })
		.map((values) => values.join(""));
	const time = (fraction: string) =>
		`2026-01-01T00:00:00${fraction ? `.${fraction}` : ""}Z`;
	fc.assert(
		fc.property(digits, digits, (left, right) => {
			const scale = Math.max(left.length, right.length, 1);
			const a = BigInt(left.padEnd(scale, "0") || "0");
			const b = BigInt(right.padEnd(scale, "0") || "0");
			const expected = a < b ? -1 : a > b ? 1 : 0;
			expect(utcPricingTimeOrder(time(left), time(right))).toBe(expected);
			expect(utcPricingTimeOrder(time(right), time(left))).toBe(
				expected === 0 ? 0 : -expected,
			);
		}),
		{ seed: 614483, numRuns: 300 },
	);
	expect(() => utcPricingTimeOrder(time("0001"), time("0"))).toThrow(
		/millisecond/,
	);
});

it("checks interval bounds at millisecond precision", () => {
	fc.assert(
		fc.property(
			fc.integer({ min: 0, max: 999 }),
			fc.integer({ min: 0, max: 999 }),
			fc.integer({ min: 0, max: 999 }),
			fc.integer({ min: 0, max: 999 }),
			(start, at, end, horizon) => {
				const time = (fraction: number) =>
					`2026-01-01T00:00:00.${String(fraction).padStart(3, "0")}Z`;
				const interval = create(EffectiveIntervalSchema, {
					start: time(start),
					end: time(end),
				});
				expect(intervalCovers(interval, time(at), time(horizon))).toBe(
					start <= at && end >= horizon,
				);
			},
		),
		{ seed: 614484, numRuns: 300 },
	);
});
