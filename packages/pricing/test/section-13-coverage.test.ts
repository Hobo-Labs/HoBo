import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { MoneySchema } from "../src/_generated/pricing_pb.js";
import { quoteScenario } from "../src/quote.js";
import {
	fixtureProviderPort,
	runBillingSync,
} from "../src/sync/billing-sync.js";
import { createSyntheticProviderCredentials } from "../src/sync/provider-port.js";
import { isQuoteVector } from "../src/types.js";
import {
	commitmentState,
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

describe("section 13 extended coverage", () => {
	it("10.5 missing dimension fails closed", () => {
		const scenario = makeScenario({
			meters: [
				{ dimension: "minute", unit: "minute", aggregation: "sum" },
				{ dimension: "storage", unit: "GiB", aggregation: "max" },
			],
			charges: [perUnitCharge("usage", "minute", "1")],
			candidate: [workload("agreement-a", [usage("storage", "1", "GiB")])],
		});
		const result = quoteScenario(scenario);
		expect(isQuoteVector(result)).toBe(false);
		if (isQuoteVector(result)) return;
		expect(result.code).toBe("RATE_CARD_NOT_FOUND");
	});

	it("§13 partial showback allows informational partial financial state", () => {
		const scenario = makeScenario({
			charges: [perUnitCharge("usage", "minute", "1")],
			candidate: [workload("agreement-a", [usage("minute", "1", "minute")])],
		});
		if (scenario.state === undefined || scenario.options === undefined) {
			throw new Error("missing scenario state");
		}
		scenario.state.completeness = "partial";
		scenario.options.allowPartialFinancialState = true;
		rehashScenario(scenario);
		expect(isQuoteVector(quoteScenario(scenario))).toBe(true);
	});

	it("§13 reconciliation dedupes provider ids via billing sync", async () => {
		const result = await runBillingSync({
			syncAt: "2026-02-01T12:00:00Z",
			periodStart: "2026-01-01T00:00:00Z",
			periodEnd: "2026-01-31T23:59:59Z",
			reservationId: "reservation-reconcile",
			eventId: "evt-reconcile",
			quotedIncrementalBilled: create(MoneySchema, {
				decimal: "1",
				currency: "USD",
			}),
			port: fixtureProviderPort([
				{
					providerChargeId: "prov-1",
					agreementId: "agreement-a",
					chargeId: "usage",
					chargePeriodStart: "2026-01-01T00:00:00Z",
					chargePeriodEnd: "2026-01-31T23:59:59Z",
					billedCostDecimal: "1",
					currency: "USD",
					category: "usage",
					completeness: "complete",
				},
			]),
			credentials: createSyntheticProviderCredentials(),
			knownActualIds: new Set(["prov-1"]),
		});
		expect("code" in result).toBe(false);
		if ("code" in result) return;
		expect(
			result.snapshot.variances.some((v) => v.kind === "duplicate-suppressed"),
		).toBe(true);
	});

	it("§13 package rounding uses ceiling on package charges", () => {
		const scenario = makeScenario({
			charges: [
				{
					base: {
						id: "pack",
						selectors: {},
						fallback: false,
						invoiceBehavior: "itemized",
					},
					usage: {
						dimension: "minute",
						timing: "arrears",
						package: {
							packageSize: "10",
							packageAmount: { decimal: "7", currency: "USD" },
							rounding: { scope: "period", multiple: "1", mode: "ceil" },
						},
					},
				},
			],
			candidate: [workload("agreement-a", [usage("minute", "11", "minute")])],
		});
		const quote = quoteScenario(scenario);
		if (!isQuoteVector(quote)) throw new Error(quote.message);
		expect(quote.candidate?.billed?.decimal).toBe("14");
	});

	it("§13 straight-line amortization option is accepted without commitments", () => {
		const scenario = makeScenario({
			charges: [perUnitCharge("usage", "minute", "1")],
			candidate: [workload("agreement-a", [usage("minute", "5", "minute")])],
			commitments: [],
		});
		if (scenario.options === undefined) throw new Error("missing options");
		scenario.options.amortization = "straight-line";
		rehashScenario(scenario);
		expect(isQuoteVector(quoteScenario(scenario))).toBe(true);
	});

	it("§13 allocation exposes advisory allocatedEffective separate from incremental effective", () => {
		const scenario = makeScenario({
			charges: [perUnitCharge("usage", "minute", "1")],
			candidate: [workload("agreement-a", [usage("minute", "30", "minute")])],
			allowances: [],
			commitments: [commitmentState()],
		});
		const quote = quoteScenario(scenario);
		if (!isQuoteVector(quote)) throw new Error(quote.message);
		expect(quote.incremental?.effective?.decimal).toBe("0");
		expect(quote.allocatedEffective?.decimal).toBe("30");
	});
});
