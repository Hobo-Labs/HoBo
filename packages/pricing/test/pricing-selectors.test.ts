import fc from "fast-check";
import { expect, it } from "vitest";
import type { JsonValue } from "../src/json.js";
import { quoteScenario } from "../src/quote.js";
import { isQuoteVector } from "../src/types.js";
import { makeScenario, money, rehashScenario, usage } from "./fixtures.js";

function charge(id: string, selector: string, price: number): JsonValue {
	return {
		base: {
			id,
			selectors: { class: selector },
			fallback: false,
			invoiceBehavior: "itemized",
		},
		usage: {
			dimension: "minute",
			timing: "arrears",
			perUnit: money(String(price)),
		},
	};
}
function job(selector: string, quantity: number): JsonValue {
	return {
		productRef: "sandbox",
		agreementRef: "agreement-a",
		direction: "add",
		quantities: {},
		usage: [usage("minute", String(quantity), "minute")],
		attributes: { class: selector },
	};
}
function successful(scenario: ReturnType<typeof makeScenario>) {
	const quote = quoteScenario(scenario);
	if (!isQuoteVector(quote)) throw new Error(`${quote.code}: ${quote.message}`);
	return quote;
}

it("rates mixed selectors against each workload", () => {
	const first = makeScenario({
		charges: [
			charge("cheap", "cheap", 1),
			charge("expensive", "expensive", 100),
		],
		candidate: [job("cheap", 1), job("expensive", 1)],
	});
	const second = makeScenario({
		charges: [
			charge("cheap", "cheap", 1),
			charge("expensive", "expensive", 100),
		],
		candidate: [job("expensive", 1), job("cheap", 1)],
	});
	const a = successful(first),
		b = successful(second);
	expect(a.incremental?.billed?.decimal).toBe("101");
	expect(a.lines.map((line) => [line.chargeId, line.billed?.decimal])).toEqual([
		["cheap", "1"],
		["expensive", "100"],
	]);
	expect(b.quoteHash).toBe(a.quoteHash);
});

it("rates generated selector groups independently of workload order", () => {
	fc.assert(
		fc.property(
			fc.integer({ min: 0, max: 500 }),
			fc.integer({ min: 0, max: 500 }),
			fc.integer({ min: 1, max: 30 }),
			fc.integer({ min: 1, max: 30 }),
			(aPrice, bPrice, aCount, bCount) => {
				const charges = [charge("a", "a", aPrice), charge("b", "b", bPrice)];
				const a = successful(
					makeScenario({
						charges,
						candidate: [job("a", aCount), job("b", bCount)],
					}),
				);
				const b = successful(
					makeScenario({
						charges,
						candidate: [job("b", bCount), job("a", aCount)],
					}),
				);
				expect(a.incremental?.billed?.decimal).toBe(
					String(aPrice * aCount + bPrice * bCount),
				);
				expect(b.quoteHash).toBe(a.quoteHash);
			},
		),
		{ seed: 614488, numRuns: 300 },
	);
});

it("rejects an unpriced workload even if another workload matches", () => {
	for (const candidate of [
		[job("a", 1), job("missing", 1)],
		[job("missing", 1), job("a", 1)],
	]) {
		const scenario = makeScenario({
			charges: [charge("a", "a", 1)],
			candidate,
		});
		const result = quoteScenario(scenario);
		if (isQuoteVector(result))
			throw new Error("unpriced workload was accepted");
		expect(result.code).toBe("RATE_CARD_NOT_FOUND");
	}
});

it("applies exclusive fallback per workload", () => {
	const base = { exclusiveGroup: "plan", invoiceBehavior: "itemized" };
	const charges: JsonValue[] = [
		{
			base: {
				...base,
				id: "special",
				selectors: { class: "special" },
				fallback: false,
			},
			usage: { dimension: "minute", timing: "arrears", perUnit: money("1") },
		},
		{
			base: { ...base, id: "standard", selectors: {}, fallback: true },
			usage: { dimension: "minute", timing: "arrears", perUnit: money("10") },
		},
	];
	const result = successful(
		makeScenario({
			charges,
			candidate: [job("special", 2), job("ordinary", 3)],
		}),
	);
	expect(result.incremental?.billed?.decimal).toBe("32");
});

it("aggregates quantities within each selected tiered charge", () => {
	const tiered: JsonValue = {
		base: {
			id: "tiered",
			selectors: { class: "a" },
			fallback: false,
			invoiceBehavior: "itemized",
		},
		usage: {
			dimension: "minute",
			timing: "arrears",
			graduated: {
				tiers: [
					{
						from: "0",
						to: "10",
						flatAmount: money("0"),
						unitAmount: money("1"),
					},
					{ from: "10", flatAmount: money("0"), unitAmount: money("0.5") },
				],
			},
		},
	};
	const result = successful(
		makeScenario({
			charges: [tiered, charge("other", "b", 100)],
			candidate: [job("a", 6), job("b", 1), job("a", 6)],
		}),
	);
	expect(result.incremental?.billed?.decimal).toBe("111");
});

it("applies fixed quantity selectors to the matching workloads", () => {
	const fixed = (id: string, selector: string, price: string): JsonValue => ({
		base: {
			id,
			selectors: { class: selector },
			fallback: false,
			invoiceBehavior: "itemized",
		},
		fixed: {
			cadence: "monthly",
			timing: "advance",
			amount: money(price),
			quantityDimension: "seats",
			proration: "none",
		},
	});
	const fixedJob = (selector: string, seats: string): JsonValue => ({
		productRef: "sandbox",
		agreementRef: "agreement-a",
		direction: "add",
		quantities: { seats },
		usage: [],
		attributes: { class: selector },
	});
	const scenario = makeScenario({
		charges: [fixed("a", "a", "1"), fixed("b", "b", "100")],
		baseline: [fixedJob("a", "0"), fixedJob("b", "0")],
		candidate: [fixedJob("a", "2"), fixedJob("b", "3")],
	});
	const agreement = scenario.state?.agreements[0];
	if (!agreement) throw new Error("missing agreement");
	agreement.quantities.seats = "0";
	const result = successful(rehashScenario(scenario));
	expect(result.incremental?.billed?.decimal).toBe("302");
});

it("counts each occurrence even if two entries share the same workload object", () => {
	const scenario = makeScenario({
		charges: [charge("a", "a", 1)],
		candidate: [job("a", 1)],
	});
	const entry = scenario.candidate[0];
	if (!entry) throw new Error("missing workload");
	scenario.candidate.push(entry);
	const result = successful(rehashScenario(scenario));
	expect(result.incremental?.billed?.decimal).toBe("2");
});

it.each([
	"missing",
	"duplicate",
])("rejects %s charge IDs for deterministic groups", (kind) => {
	const scenario = makeScenario({
		charges: [charge("a", "a", 1), charge("b", "b", 2)],
		candidate: [job("a", 1), job("b", 1)],
	});
	const charges = scenario.catalog?.rateCards[0]?.charges;
	if (!charges?.[0]?.base || !charges[1]?.base)
		throw new Error("missing charge");
	charges[1].base.id = kind === "missing" ? "" : charges[0].base.id;
	const result = quoteScenario(rehashScenario(scenario));
	if (isQuoteVector(result))
		throw new Error("ambiguous charge identity accepted");
	expect(result.code).toBe("INVALID_PRICING_INPUT");
});

it("rejects a workload whose product differs from its agreement", () => {
	const scenario = makeScenario({
		charges: [charge("a", "a", 1)],
		candidate: [job("a", 1)],
	});
	const candidate = scenario.candidate[0];
	if (!candidate) throw new Error("missing workload");
	candidate.productRef = "other-product";
	const result = quoteScenario(scenario);
	if (isQuoteVector(result)) throw new Error("wrong-product workload accepted");
	expect(result.code).toBe("INVALID_PRICING_INPUT");
});

it("rejects measurements for a dimension without a product meter", () => {
	const scenario = makeScenario({
		charges: [charge("a", "a", 1)],
		candidate: [job("a", 1)],
	});
	const measurement = scenario.candidate[0]?.usage[0];
	if (!measurement) throw new Error("missing measurement");
	measurement.dimension = "unknown";
	const result = quoteScenario(scenario);
	if (isQuoteVector(result)) throw new Error("unmetered workload accepted");
	expect(result.code).toBe("RATE_CARD_NOT_FOUND");
});

it("rejects repeated meter dimensions rather than charging twice", () => {
	const scenario = makeScenario({
		charges: [charge("a", "a", 1)],
		candidate: [job("a", 1)],
	});
	const product = scenario.catalog?.products[0];
	const meter = product?.meters[0];
	if (!product || !meter) throw new Error("missing meter");
	product.meters.push(meter);
	const result = quoteScenario(rehashScenario(scenario));
	if (isQuoteVector(result)) throw new Error("duplicate meter accepted");
	expect(result.code).toBe("INVALID_PRICING_INPUT");
});

it.each([
	"dimension",
	"unit",
] as const)("rejects a meter with a missing %s", (field) => {
	const scenario = makeScenario({ charges: [charge("a", "a", 1)] });
	const meter = scenario.catalog?.products[0]?.meters[0];
	if (!meter) throw new Error("missing meter");
	meter[field] = "";
	const result = quoteScenario(rehashScenario(scenario));
	if (isQuoteVector(result)) throw new Error("invalid meter accepted");
	expect(result.code).toBe("INVALID_PRICING_INPUT");
});

it("rates baseline and candidate selector groups independently before subtracting", () => {
	const scenario = makeScenario({
		charges: [charge("a", "a", 1), charge("b", "b", 100)],
		baseline: [job("a", 2), job("b", 3)],
		candidate: [job("b", 5), job("a", 4)],
	});
	const result = successful(scenario);
	expect(result.baseline?.billed?.decimal).toBe("302");
	expect(result.candidate?.billed?.decimal).toBe("806");
	expect(result.incremental?.billed?.decimal).toBe("504");
});
