import { describe, expect, it } from "vitest";
import type { QuoteVector } from "../src/_generated/pricing_pb.js";
import { quoteScenario } from "../src/quote.js";
import { isQuoteVector } from "../src/types.js";
import {
	allowanceState,
	cloneScenario,
	commitmentState,
	creditState,
	fixedCharge,
	makeScenario,
	money,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

function successfulQuote(
	scenario: Parameters<typeof quoteScenario>[0],
): QuoteVector {
	const result = quoteScenario(scenario);
	if (!isQuoteVector(result)) {
		throw new Error(`${result.code}: ${result.message}`);
	}
	return result;
}

describe("section 13 adversarial commercial-term fixtures", () => {
	it("10.1 rates only usage beyond the existing 950/1000 minutes", () => {
		const quote = successfulQuote(quoteScenarioFixture());

		expect(quote.baseline?.billed).toMatchObject({ decimal: "20" });
		expect(quote.candidate?.billed).toMatchObject({ decimal: "20.5" });
		expect(quote.incremental).toMatchObject({
			billed: { decimal: "0.5", currency: "USD" },
			dueNow: { decimal: "0.5", currency: "USD" },
			effective: { decimal: "0.5", currency: "USD" },
		});
		expect(quote.consumption).toHaveLength(1);
		expect(quote.consumption[0]).toMatchObject({
			sourceId: "included-minutes",
			quantity: { decimal: "50", unit: "minute" },
		});
	});

	it("10.2 distinguishes paid-credit basis from promotional credit", () => {
		const paidFirst = quoteScenarioFixture({
			charges: [perUnitCharge("usage", "minute", "1")],
			candidate: [workload("agreement-a", [usage("minute", "10", "minute")])],
			allowances: [],
			credits: [
				creditState("paid", "acquisition", 0),
				creditState("promo", "zero", 1),
			],
		});
		const paidQuote = successfulQuote(paidFirst);
		expect(paidQuote.incremental).toMatchObject({
			billed: { decimal: "0" },
			effective: { decimal: "9" },
		});
		expect(paidQuote.consumption.map((entry) => entry.sourceId)).toEqual([
			"paid",
		]);

		const promoFirst = cloneScenario(paidFirst);
		const paid = promoFirst.state?.credits.find(
			(entry) => entry.grant?.id === "paid",
		);
		const promo = promoFirst.state?.credits.find(
			(entry) => entry.grant?.id === "promo",
		);
		if (paid?.grant === undefined || promo?.grant === undefined) {
			throw new Error("credit fixtures are missing");
		}
		paid.grant.priority = 1;
		promo.grant.priority = 0;
		const promoQuote = successfulQuote(rehashScenario(promoFirst));
		expect(promoQuote.incremental).toMatchObject({
			billed: { decimal: "0" },
			effective: { decimal: "0" },
		});
		expect(promoQuote.consumption.map((entry) => entry.sourceId)).toEqual([
			"promo",
		]);
	});

	it("10.3 consumes a $100 commitment with $40 used and $30 candidate", () => {
		const quote = successfulQuote(
			quoteScenarioFixture({
				charges: [perUnitCharge("usage", "minute", "1")],
				candidate: [workload("agreement-a", [usage("minute", "30", "minute")])],
				allowances: [],
				commitments: [commitmentState()],
			}),
		);

		expect(quote.incremental).toMatchObject({
			billed: { decimal: "0" },
			dueNow: { decimal: "0" },
			effective: { decimal: "30" },
		});
		expect(quote.consumption[0]).toMatchObject({
			sourceId: "commitment-a",
			quantity: { decimal: "30" },
		});
		expect(quote.remainingHeadroom[0]).toMatchObject({
			sourceId: "commitment-a",
			quantity: { decimal: "30" },
		});
		expect(quote.projectedWaste[0]?.amount).toMatchObject({
			value: { case: "money", value: { decimal: "30" } },
		});
	});

	it("10.4 keeps graduated and volume tiers distinct for 90 + 20 units", () => {
		const tiers = [
			{ from: "0", to: "100", flatAmount: money("0"), unitAmount: money("1") },
			{ from: "100", flatAmount: money("0"), unitAmount: money("0.8") },
		];
		const component = (price: "graduated" | "volume") => ({
			base: {
				id: "tiered",
				selectors: {},
				fallback: false,
				invoiceBehavior: "itemized",
			},
			usage: {
				dimension: "minute",
				timing: "advance",
				[price]: { tiers },
			},
		});
		const fixture = {
			baseline: [workload("agreement-a", [usage("minute", "90", "minute")])],
			candidate: [workload("agreement-a", [usage("minute", "20", "minute")])],
			allowances: [],
			credits: [],
			commitments: [],
		};
		const volume = successfulQuote(
			quoteScenarioFixture({
				...fixture,
				charges: [component("volume")],
			}),
		);
		const graduated = successfulQuote(
			quoteScenarioFixture({
				...fixture,
				charges: [component("graduated")],
			}),
		);

		expect(volume.baseline?.billed).toMatchObject({ decimal: "90" });
		expect(volume.candidate?.billed).toMatchObject({ decimal: "88" });
		expect(volume.incremental?.billed).toMatchObject({ decimal: "-2" });
		expect(graduated.candidate?.billed).toMatchObject({ decimal: "108" });
		expect(graduated.incremental?.billed).toMatchObject({ decimal: "18" });
	});

	it("10.5 rates a multidimensional sandbox composite independently", () => {
		const quote = successfulQuote(
			quoteScenarioFixture({
				meters: [
					{ dimension: "request", unit: "request", aggregation: "sum" },
					{ dimension: "storage", unit: "GiB", aggregation: "max" },
					{ dimension: "user", unit: "user", aggregation: "unique-count" },
				],
				charges: [
					perUnitCharge("requests", "request", "0.001"),
					perUnitCharge("storage", "storage", "0.5"),
					perUnitCharge("users", "user", "2"),
				],
				baseline: [
					workload("agreement-a", [
						usage("request", "1000", "request"),
						usage("storage", "1", "GiB"),
						usage("user", "0", "user", ["a", "b"]),
					]),
				],
				candidate: [
					workload("agreement-a", [
						usage("request", "500", "request"),
						usage("storage", "2", "GiB"),
						usage("user", "0", "user", ["b", "c"]),
					]),
				],
			}),
		);

		expect(quote.baseline?.billed).toMatchObject({ decimal: "5.5" });
		expect(quote.candidate?.billed).toMatchObject({ decimal: "8.5" });
		expect(quote.incremental?.billed).toMatchObject({ decimal: "3" });
		expect(
			quote.lines.find((line) => line.chargeId === "users")?.quantity,
		).toMatchObject({ decimal: "3", unit: "user" });
	});
});

describe("section 13 adversarial fixtures (10.6–10.11)", () => {
	it("10.8 rejects stale financial observations", () => {
		const scenario = quoteScenarioFixture();
		const observation = scenario.state?.observations[0];
		if (observation === undefined) {
			throw new Error("missing state observation");
		}
		observation.validUntil = "2026-01-15T00:00:00.000Z";
		const result = quoteScenario(rehashScenario(scenario));
		expect(result.$typeName).toBe("hobo.pricing.v1.PricingRejected");
		if (result.$typeName === "hobo.pricing.v1.PricingRejected") {
			expect(result.code).toBe("STALE_OBSERVATION");
		}
	});

	it("10.9 rejects cross-currency catalogs", () => {
		const scenario = makeScenario({
			charges: [perUnitCharge("usage", "minute", "1")],
			candidate: [workload("agreement-a", [usage("minute", "1", "minute")])],
		});
		scenario.catalog.currency = "USD";
		scenario.catalog.rateCards[0]!.currency = "EUR";
		const rehashed = rehashScenario(scenario);
		const result = quoteScenario(rehashed);
		expect(result.$typeName).toBe("hobo.pricing.v1.PricingRejected");
	});

	it("10.11 breaks ties deterministically at zero incremental billed", () => {
		const scenario = makeScenario({
			charges: [perUnitCharge("usage", "minute", "0")],
			candidate: [workload("agreement-a", [usage("minute", "0", "minute")])],
		});
		const quote = successfulQuote(scenario);
		expect(quote.incremental?.billed).toMatchObject({ decimal: "0" });
	});
});

function quoteScenarioFixture(
	overrides?: Partial<Parameters<typeof makeScenario>[0]>,
) {
	return makeScenario({
		charges: [
			fixedCharge("subscription", "20"),
			perUnitCharge("overage", "minute", "0.01"),
		],
		candidate: [workload("agreement-a", [usage("minute", "100", "minute")])],
		allowances: [allowanceState("included-minutes", "50", "950")],
		...overrides,
	});
}
