import { clone } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ProviderAgreementSchema,
	type QuoteScenario,
	type QuoteVector,
	RateCardSchema,
} from "../src/_generated/pricing_pb.js";
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

	it("10.6 rates migration source removal and target addition jointly", () => {
		const scenario = quoteScenarioFixture({
			charges: [perUnitCharge("usage", "minute", "0.02")],
			baseline: [workload("agreement-a", [usage("minute", "100", "minute")])],
			candidate: [
				workload("agreement-a", [usage("minute", "100", "minute")]),
				workload("agreement-b", [usage("minute", "100", "minute")]),
			],
			allowances: [],
		});
		scenario.action = "migrate";
		scenario.sourceProviderAgreementIds = ["agreement-a"];
		const removal = scenario.candidate[0];
		if (removal === undefined) throw new Error("missing migration source");
		removal.direction = "remove";
		addSecondaryAgreement(scenario, "0.01");

		const quote = successfulQuote(rehashScenario(scenario));

		expect(quote.baseline?.billed).toMatchObject({ decimal: "2" });
		expect(quote.candidate?.billed).toMatchObject({ decimal: "1" });
		expect(quote.incremental?.billed).toMatchObject({ decimal: "-1" });
		expect(quote.lines).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					agreementRef: "agreement-a",
					billed: expect.objectContaining({ decimal: "0" }),
				}),
				expect.objectContaining({
					agreementRef: "agreement-b",
					billed: expect.objectContaining({ decimal: "1" }),
				}),
			]),
		);
	});

	it("10.7 enforces a free plan hard limit without billing overage", () => {
		const scenario = quoteScenarioFixture({
			charges: [perUnitCharge("usage", "minute", "1")],
			baseline: [],
			candidate: [workload("agreement-a", [usage("minute", "50", "minute")])],
		});
		const allowance = scenario.state?.allowances[0]?.grant;
		if (allowance === undefined) throw new Error("missing hard-limit grant");
		allowance.exhaustion = "block-usage";
		rehashScenario(scenario);

		expect(successfulQuote(scenario).incremental?.billed).toMatchObject({
			decimal: "0",
		});
		const excessive = cloneScenario(scenario);
		const measurement = excessive.candidate[0]?.usage[0]?.quantity;
		if (measurement === undefined) throw new Error("missing usage fixture");
		measurement.decimal = "51";
		expect(quoteScenario(excessive)).toMatchObject({
			code: "USAGE_LIMIT_EXCEEDED",
		});
	});

	it("10.8 rejects observations that do not cover the quote horizon", () => {
		const scenario = quoteScenarioFixture();
		const observation = scenario.state?.observations[0];
		if (observation === undefined) throw new Error("missing state observation");
		observation.validUntil = "2026-01-15T00:00:00Z";

		expect(quoteScenario(rehashScenario(scenario))).toMatchObject({
			code: "STALE_OBSERVATION",
			message: expect.stringContaining("does not cover the quote horizon"),
		});
	});

	it("10.9 refuses to rank or sum mixed currencies", () => {
		const scenario = quoteScenarioFixture({
			charges: [perUnitCharge("usage", "minute", "1")],
			candidate: [workload("agreement-b", [usage("minute", "10", "minute")])],
			allowances: [],
		});
		addSecondaryAgreement(scenario, "0.5", "EUR");

		expect(quoteScenario(rehashScenario(scenario))).toMatchObject({
			code: "CROSS_CURRENCY",
		});
	});

	it("10.10 prices joint non-additive actions once instead of summing independent deltas", () => {
		const scenario = quoteScenarioFixture({
			charges: [volumeCharge()],
			baseline: [workload("agreement-a", [usage("minute", "90", "minute")])],
			candidate: [
				workload("agreement-a", [usage("minute", "10", "minute")]),
				workload("agreement-a", [usage("minute", "10", "minute")]),
			],
			allowances: [],
		});
		const separate = quoteScenarioFixture({
			charges: [volumeCharge()],
			baseline: [workload("agreement-a", [usage("minute", "90", "minute")])],
			candidate: [workload("agreement-a", [usage("minute", "10", "minute")])],
			allowances: [],
		});

		const joint = successfulQuote(scenario);
		const independent = successfulQuote(separate);

		expect(joint.candidate?.billed).toMatchObject({ decimal: "88" });
		expect(joint.incremental?.billed).toMatchObject({ decimal: "-2" });
		expect(independent.incremental?.billed).toMatchObject({ decimal: "-10" });
		expect(joint.incremental?.billed?.decimal).not.toBe("-20");
	});

	it("10.11 preserves zero-cost ties and confines hourly commitments to one UTC bucket", () => {
		const zero = quoteScenarioFixture({
			charges: [perUnitCharge("usage", "minute", "0")],
			candidate: [workload("agreement-a", [usage("minute", "10", "minute")])],
			allowances: [],
		});
		addSecondaryAgreement(zero, "0");
		const zeroB = cloneScenario(zero);
		const candidateB = zeroB.candidate[0];
		if (candidateB === undefined)
			throw new Error("missing zero-cost candidate");
		candidateB.agreementRef = "agreement-b";
		const quoteA = successfulQuote(zero);
		const quoteB = successfulQuote(zeroB);
		expect(quoteA.incremental?.billed).toMatchObject({ decimal: "0" });
		expect(quoteB.incremental?.billed).toMatchObject({ decimal: "0" });
		expect(successfulQuote(zero).quoteHash).toBe(quoteA.quoteHash);

		const hourly = hourlyCommitmentScenario();
		const quote = successfulQuote(hourly);
		expect(quote.incremental).toMatchObject({
			billed: { decimal: "0" },
			effective: { decimal: "30" },
		});
		expect(quote.consumption[0]).toMatchObject({
			sourceId: "commitment-a",
			quantity: { decimal: "30" },
		});
		const crossHour = cloneScenario(hourly);
		crossHour.horizon = "2026-01-01T01:30:00Z";
		expect(quoteScenario(crossHour)).toMatchObject({
			code: "PRICING_MODEL_UNSUPPORTED",
			message: expect.stringContaining("hour"),
		});
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

function addSecondaryAgreement(
	scenario: QuoteScenario,
	unitPrice: string,
	currency = "USD",
): void {
	const sourceAgreement = scenario.state?.agreements[0];
	const sourceCard = scenario.catalog?.rateCards[0];
	if (sourceAgreement === undefined || sourceCard === undefined) {
		throw new Error("missing secondary agreement fixture");
	}
	const agreement = clone(ProviderAgreementSchema, sourceAgreement);
	agreement.id = "agreement-b";
	agreement.providerAccountRef = "account-b";
	for (const entry of agreement.rateSchedule) entry.rateCardId = "card-b";
	const rateCard = clone(RateCardSchema, sourceCard);
	rateCard.id = "card-b";
	rateCard.currency = currency;
	for (const charge of rateCard.charges) {
		if (charge.variant.case === "fixed") {
			charge.variant.value.amount.currency = currency;
		} else if (
			charge.variant.case === "usage" &&
			charge.variant.value.price.case === "perUnit"
		) {
			charge.variant.value.price.value.decimal = unitPrice;
			charge.variant.value.price.value.currency = currency;
		}
	}
	scenario.state?.agreements.push(agreement);
	scenario.catalog?.rateCards.push(rateCard);
	rehashScenario(scenario);
}

function volumeCharge() {
	return {
		base: {
			id: "tiered",
			selectors: {},
			fallback: false,
			invoiceBehavior: "itemized",
		},
		usage: {
			dimension: "minute",
			timing: "advance",
			volume: {
				tiers: [
					{
						from: "0",
						to: "100",
						flatAmount: money("0"),
						unitAmount: money("1"),
					},
					{
						from: "100",
						flatAmount: money("0"),
						unitAmount: money("0.8"),
					},
				],
			},
		},
	};
}

function hourlyCommitmentScenario(): QuoteScenario {
	const scenario = quoteScenarioFixture({
		charges: [perUnitCharge("usage", "minute", "1")],
		candidate: [workload("agreement-a", [usage("minute", "30", "minute")])],
		allowances: [],
		commitments: [commitmentState()],
	});
	scenario.horizon = "2026-01-01T00:30:00Z";
	const commitment = scenario.state?.commitments[0]?.commitment;
	if (commitment === undefined) throw new Error("missing hourly commitment");
	commitment.bucketGranularity = "hour";
	return rehashScenario(scenario);
}
