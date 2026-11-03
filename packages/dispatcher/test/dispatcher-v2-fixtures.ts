import {
	catalogHashOf,
	isJsonObject,
	parseQuoteScenario,
	quoteScenarioToJson,
	type QuoteScenario,
	stateHashOf,
} from "@hobo/pricing";

const AT = "2026-01-01T00:00:00Z";
const INTERVAL = {
	start: "2025-01-01T00:00:00Z",
	end: "2027-01-01T00:00:00Z",
};
const EVIDENCE = {
	source: "fixture://dispatcher-v2",
	observedAt: AT,
	validFrom: AT,
	validUntil: "2027-01-01T00:00:00Z",
	evidenceHash: `sha256:${"0".repeat(64)}`,
};

export function dispatchQuoteScenario(
	agreementRef: string,
	unitPrice: string,
): QuoteScenario {
	const scenario = parseQuoteScenario({
		action: "dispatch",
		at: AT,
		horizon: "2026-01-31T23:59:59Z",
		pricingCatalogHash: "",
		catalog: {
			schema: "hobo.pricing.catalog/v1",
			catalogHash: "",
			products: [
				{
					id: "runner",
					providerId: agreementRef,
					meters: [{ dimension: "minute", unit: "minute", aggregation: "sum" }],
				},
			],
			rateCards: [
				{
					id: "card-v1",
					version: "1",
					currency: "USD",
					effective: INTERVAL,
					charges: [
						{
							base: {
								id: "usage",
								selectors: {},
								fallback: false,
								invoiceBehavior: "itemized",
							},
							usage: {
								dimension: "minute",
								timing: "advance",
								perUnit: { decimal: unitPrice, currency: "USD" },
							},
						},
					],
				},
			],
			allowances: [],
			credits: [],
			commitments: [],
		},
		state: {
			schema: "hobo.pricing/v1",
			view: "commercial-state",
			tenantId: "tenant-a",
			seq: "1",
			stateHash: "",
			asOf: AT,
			agreements: [
				{
					id: agreementRef,
					tenantId: "tenant-a",
					providerAccountRef: agreementRef,
					productId: "runner",
					rateSchedule: [{ rateCardId: "card-v1", effective: INTERVAL }],
					status: "active",
					term: INTERVAL,
					billingPeriod: {
						interval: "monthly",
						anchor: AT,
						timeZone: "UTC",
					},
					quantities: {},
					cancellation: {
						allowed: false,
						refund: "none",
						fee: { decimal: "0", currency: "USD" },
						notice: "",
					},
					evidence: EVIDENCE,
				},
			],
			allowances: [],
			credits: [],
			commitments: [],
			periodActuals: [],
			completeness: "complete",
			observations: [
				{
					source: "fixture://dispatcher-v2-state",
					observedAt: AT,
					validUntil: "2027-01-01T00:00:00Z",
					detail: "complete fixture",
				},
			],
		},
		baseline: [],
		candidate: [
			{
				productRef: "runner",
				agreementRef,
				direction: "add",
				quantities: {},
				usage: [
					{
						dimension: "minute",
						quantity: { decimal: "10", unit: "minute" },
						observedAt: AT,
						uniqueValues: [],
					},
				],
				attributes: {},
			},
		],
		sourceProviderAgreementIds: [],
		options: {
			allowNewProviderAgreement: true,
			allowCancellation: false,
			amortization: "provider-actual",
			allocationConvention: "marginal-consume",
			allocationForecast: [],
		},
	});
	if (scenario === undefined) throw new Error("invalid dispatcher v2 fixture");
	return rehash(scenario);
}

export function staleDispatchQuoteScenario(
	agreementRef: string,
): QuoteScenario {
	const scenario = dispatchQuoteScenario(agreementRef, "0.01");
	const observation = scenario.state?.observations[0];
	if (observation === undefined) throw new Error("missing observation fixture");
	observation.validUntil = "2026-01-01T00:00:00Z";
	return rehash(scenario);
}

export function zeroCostCommitmentDispatchScenario(
	agreementRef: string,
	horizon: string,
): QuoteScenario {
	const base = dispatchQuoteScenario(agreementRef, "1");
	const json = quoteScenarioToJson(base);
	if (!isJsonObject(json)) {
		throw new Error("invalid dispatch fixture json");
	}
	json.horizon = horizon;
	const state = json.state;
	if (!isJsonObject(state)) {
		throw new Error("missing state fixture");
	}
	state.commitments = [
		{
			commitment: {
				id: "commitment-a",
				tenantId: "tenant-a",
				kind: "spend",
				amount: { money: { decimal: "100", currency: "USD" } },
				bucketGranularity: "billing-period",
				term: INTERVAL,
				payment: "upfront",
				underuse: "forfeit",
				amortization: "provider-actual",
				scope: {
					productIds: [],
					rateCardIds: [],
					chargeIds: [],
					dimensions: [],
				},
				evidence: EVIDENCE,
			},
			remaining: { money: { decimal: "60", currency: "USD" } },
			used: { money: { decimal: "40", currency: "USD" } },
		},
	];
	const scenario = parseQuoteScenario(json);
	if (scenario === undefined) throw new Error("invalid commitment fixture");
	return rehash(scenario);
}

function rehash(scenario: QuoteScenario): QuoteScenario {
	if (scenario.catalog === undefined || scenario.state === undefined) {
		throw new Error("dispatcher v2 fixture requires catalog and state");
	}
	scenario.catalog.catalogHash = catalogHashOf(scenario.catalog);
	scenario.pricingCatalogHash = scenario.catalog.catalogHash;
	scenario.state.stateHash = stateHashOf(scenario.state);
	return scenario;
}
