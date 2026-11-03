import assert from "node:assert/strict";
import {
	type Money,
	type QuoteAmounts,
	type QuoteVector,
	quoteVectorToJson,
	stableHash,
} from "@hobo/pricing";
import { describe, expect, it, vi } from "vitest";
import {
	authorizeBillingSpend,
	BROKER_EVENTS,
	type BrokerCatalog,
	createBroker,
	createBrokerHttpHandler,
	createPricingBillingPlaneV2,
	type HoboBrokerDeps,
	type ResolutionReceipt,
} from "../src/index.js";

const PRICING_CATALOG_HASH = `sha256:${"c".repeat(64)}`;
const OTHER_CATALOG_HASH = `sha256:${"d".repeat(64)}`;
const RAIL_HASH = `sha256:${"a".repeat(64)}`;

function money(decimal: string, currency: string): Money {
	return { $typeName: "hobo.pricing.v1.Money", decimal, currency };
}

function incremental(decimal: string, currency: string): QuoteAmounts {
	return {
		$typeName: "hobo.pricing.v1.QuoteAmounts",
		billed: money(decimal, currency),
	};
}

function quoteMessage(fields: Partial<QuoteVector> = {}): QuoteVector {
	return {
		$typeName: "hobo.pricing.v1.QuoteVector",
		schema: "hobo.pricing.quote/v1",
		ratingAlgorithmVersion: "",
		pricingCatalogHash: PRICING_CATALOG_HASH,
		capabilityCatalogHash: "",
		stateHash: "",
		quoteHash: "",
		allocationConvention: "",
		newObligations: [],
		lines: [],
		consumption: [],
		remainingHeadroom: [],
		projectedWaste: [],
		assumptions: [],
		unpriced: [],
		...fields,
	};
}

function seal(quote: QuoteVector): QuoteVector {
	const blanked = quoteMessage({ ...quote, quoteHash: "" });
	return quoteMessage({
		...blanked,
		quoteHash: stableHash(quoteVectorToJson(blanked)),
	});
}

function makeQuote(decimal = "1.00"): QuoteVector {
	return seal(
		quoteMessage({
			incremental: incremental(decimal, "USD"),
			eligibility: {
				$typeName: "hobo.pricing.v1.Eligibility",
				eligible: true,
				rejectedCandidates: [],
			},
		}),
	);
}

const policies = {
	schemaVersion: "hobo.broker/v1",
	brokerId: "broker:pricing-test",
	placementPolicies: [
		{ id: "pp-bindle", scopeKind: "bindle", objective: "min-cost" },
	],
	billing: {
		quota: "deployments/day",
		quotaUsed: 0,
		quotaLimit: 10,
		budgetUsd: 100,
		spendCapUsd: 50,
	},
	delivery: { engine: "in-proc", syncMode: "manual" },
};

const catalog: BrokerCatalog = {
	catalogHash: "sha256:provider-catalog",
	definitions: () => [
		{
			id: "provider:hobo:http-service",
			providerId: "provider",
			port: "hobo:http-service",
			features: [],
			regions: ["us-east-1"],
			cost: { sku: "svc", unit: "hour", marginalPrice: "0.01" },
			satisfies: (request) =>
				request.port === "hobo:http-service"
					? { kind: "full" }
					: { kind: "none" },
		},
	],
};

const baseRequest = {
	schemaVersion: "hobo.broker/v1",
	requestId: "req-pricing",
	scope: { bindleId: "bindle:checkout" },
	requirements: [{ resourceId: "api", port: "hobo:http-service" }],
	spendEstimateUsd: 500,
};

function brokerWith(overrides: Partial<HoboBrokerDeps> = {}) {
	return createBroker({
		stationId: "station:pricing-test",
		railHash: RAIL_HASH,
		policies,
		catalog,
		...overrides,
	});
}

function pinnedRequest(quote: QuoteVector) {
	return {
		...baseRequest,
		quoteHash: quote.quoteHash,
		pricingCatalogHash: quote.pricingCatalogHash,
	};
}

function resolvedData(events: Array<{ type: string; data: object }>) {
	return events.find((event) => event.type === BROKER_EVENTS.Resolved)?.data;
}

describe("BillingPlaneV2 broker routing", () => {
	it("keeps the exact legacy V1 path and receipt shape without quote pins", async () => {
		const authorize = vi.fn(() => ({ ok: true, reasons: [] }));
		const authorizeV2 = vi.fn(() => ({ ok: true, reasons: [] }));
		const result = await brokerWith({
			billingPlane: { authorize },
			billingPlaneV2: { authorize: authorizeV2 },
		}).resolve(baseRequest);

		expect(authorize).toHaveBeenCalledWith({
			spendEstimateUsd: 500,
			billing: policies.billing,
		});
		expect(authorizeV2).not.toHaveBeenCalled();
		expect(result.outcome).toBe("resolved");
		expect(result.receipt).not.toHaveProperty("quoteHash");
		expect(result.receipt).not.toHaveProperty("pricingCatalogHash");
		expect(resolvedData(result.events)).not.toHaveProperty("quoteHash");
		expect(resolvedData(result.events)).not.toHaveProperty(
			"pricingCatalogHash",
		);
	});

	it("authorizes a valid hash pair and pins the receipt and resolved event", async () => {
		const quote = makeQuote("1.000000000000000001");
		const result = await brokerWith({
			billingPlaneV2: createPricingBillingPlaneV2([quote]),
		}).resolve(pinnedRequest(quote));

		expect(result.outcome).toBe("resolved");
		expect(result.receipt?.quoteHash).toBe(quote.quoteHash);
		expect(result.receipt?.pricingCatalogHash).toBe(PRICING_CATALOG_HASH);
		expect(resolvedData(result.events)).toMatchObject({
			quoteHash: quote.quoteHash,
			pricingCatalogHash: PRICING_CATALOG_HASH,
		});
	});

	it("fails closed instead of calling V1 when V2 is unavailable", async () => {
		const quote = makeQuote();
		const authorize = vi.fn(() => ({ ok: true, reasons: [] }));
		const result = await brokerWith({
			billingPlane: { authorize },
		}).resolve(pinnedRequest(quote));

		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons).toEqual([
			expect.objectContaining({
				plane: "billing",
				code: "quote-authorization-unavailable",
			}),
		]);
		expect(authorize).not.toHaveBeenCalled();
	});

	it("rejects a tampered quote even when its supplied hash is pinned", async () => {
		const quote = makeQuote("1");
		const tampered = quoteMessage({
			...quote,
			incremental: incremental("2", "USD"),
		});
		const result = await brokerWith({
			billingPlaneV2: createPricingBillingPlaneV2([tampered]),
		}).resolve(pinnedRequest(quote));

		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons[0]?.code).toBe(
			"quote-authorization-failed",
		);
	});

	it("rejects a quote whose pricing catalog does not match the pin", async () => {
		const quote = makeQuote();
		const result = await brokerWith({
			billingPlaneV2: createPricingBillingPlaneV2([quote]),
		}).resolve({
			...pinnedRequest(quote),
			pricingCatalogHash: OTHER_CATALOG_HASH,
		});

		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons[0]?.code).toBe(
			"quote-authorization-failed",
		);
	});

	it("uses exact decimal cap comparisons and keeps HTTP billing rejection at 402", async () => {
		const quote = makeQuote("50.000000000000000001");
		const handle = createBrokerHttpHandler(
			brokerWith({ billingPlaneV2: createPricingBillingPlaneV2([quote]) }),
		);
		const response = await handle({
			method: "POST",
			path: "/broker/resolve",
			body: pinnedRequest(quote),
		});

		expect(response.status).toBe(402);
		expect(response.body.rejection).toMatchObject({
			reasons: [{ plane: "billing", code: "spend-cap-exceeded" }],
		});
	});

	it("preserves valid pins through HTTP delivery and rejects a malformed pair", async () => {
		const delivered: ResolutionReceipt[] = [];
		const handle = createBrokerHttpHandler(
			brokerWith({
				deliveryPlane: {
					submit(receipt) {
						delivered.push(receipt);
						return {
							engine: "in-proc",
							target: "test",
							document: {},
						};
					},
				},
			}),
		);
		const quote = makeQuote();
		const receipt = {
			schemaVersion: "hobo.broker/v1",
			requestId: "req-pricing",
			brokerId: "broker:pricing-test",
			catalogHash: "sha256:provider-catalog",
			policyHash: RAIL_HASH,
			placementPolicyId: "pp-bindle",
			stationId: "station:pricing-test",
			railHash: RAIL_HASH,
			quoteHash: quote.quoteHash,
			pricingCatalogHash: quote.pricingCatalogHash,
		};
		const accepted = await handle({
			method: "POST",
			path: "/broker/deliver",
			body: receipt,
		});
		expect(accepted.status).toBe(200);
		expect(delivered[0]?.quoteHash).toBe(quote.quoteHash);
		expect(delivered[0]?.pricingCatalogHash).toBe(PRICING_CATALOG_HASH);

		const malformed = await handle({
			method: "POST",
			path: "/broker/deliver",
			body: { ...receipt, pricingCatalogHash: null },
		});
		expect(malformed.status).toBe(400);
		expect(malformed.body.error).toBe("invalid-receipt");
	});
});

describe("createPricingBillingPlaneV2", () => {
	const billing = policies.billing;

	it("requires a present quote with a recomputed hash", () => {
		const quote = makeQuote();
		const result = createPricingBillingPlaneV2([]).authorize({
			quoteHash: quote.quoteHash,
			pricingCatalogHash: PRICING_CATALOG_HASH,
			billing,
		});
		expect(result.reasons[0]?.code).toBe("quote-authorization-failed");
	});

	it("fails closed for ineligible, unpriced, incomplete, negative, and non-USD quotes", () => {
		const quote = makeQuote();
		const invalidQuotes = [
			seal(
				quoteMessage({
					...quote,
					eligibility: {
						$typeName: "hobo.pricing.v1.Eligibility",
						eligible: false,
						rejectedCandidates: [],
					},
				}),
			),
			seal(
				quoteMessage({
					...quote,
					unpriced: [
						{
							$typeName: "hobo.pricing.v1.UnpricedItem",
							productRef: "product",
							agreementRef: "agreement",
							chargeId: "charge",
							reason: "unpriced",
						},
					],
				}),
			),
			seal(quoteMessage({ ...quote, incremental: undefined })),
			seal(
				quoteMessage({
					...quote,
					incremental: incremental("-0.01", "USD"),
				}),
			),
			seal(
				quoteMessage({
					...quote,
					incremental: incremental("1", "EUR"),
				}),
			),
		];

		for (const invalid of invalidQuotes) {
			const result = createPricingBillingPlaneV2([invalid]).authorize({
				quoteHash: invalid.quoteHash,
				pricingCatalogHash: PRICING_CATALOG_HASH,
				billing,
			});
			expect(result.ok).toBe(false);
			expect(result.reasons[0]?.code).toBe("quote-authorization-failed");
		}
	});

	it("compares budget exactly and treats zero limits as unlimited", () => {
		const quote = makeQuote("50.000000000000000001");
		const plane = createPricingBillingPlaneV2([quote]);
		const denied = plane.authorize({
			quoteHash: quote.quoteHash,
			pricingCatalogHash: PRICING_CATALOG_HASH,
			billing: { ...billing, spendCapUsd: 0, budgetUsd: 50 },
		});
		expect(denied.reasons[0]?.code).toBe("budget-exceeded");

		const unlimited = plane.authorize({
			quoteHash: quote.quoteHash,
			pricingCatalogHash: PRICING_CATALOG_HASH,
			billing: { ...billing, spendCapUsd: 0, budgetUsd: 0 },
		});
		expect(unlimited).toEqual({ ok: true, reasons: [] });
	});

	it("prefers quote incremental decimal over legacy spend estimate", () => {
		const result = authorizeBillingSpend({
			spendEstimateUsd: 100,
			quoteIncrementalUsd: 99,
			quoteIncrementalDecimal: "5.25",
			billing: {
				quota: "default",
				quotaUsed: 0,
				quotaLimit: 1000,
				budgetUsd: 50,
				spendCapUsd: 40,
			},
		});
		assert.equal(result.ok, true);
		assert.equal(result.authorizedUsd, 5.25);
	});

	it("rejects negative quote incremental decimal", () => {
		const result = authorizeBillingSpend({
			quoteIncrementalDecimal: "-0.01",
			billing: {
				quota: "default",
				quotaUsed: 0,
				quotaLimit: 1000,
				budgetUsd: 50,
				spendCapUsd: 40,
			},
		});
		assert.equal(result.ok, false);
		assert.equal(result.reasons[0]?.code, "spend-estimate-invalid");
	});
});
