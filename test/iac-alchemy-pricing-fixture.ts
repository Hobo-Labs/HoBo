import type { QuoteScenario } from "../packages/pricing/src/_generated/pricing_pb.js";
import { catalogHashOf } from "../packages/pricing/src/catalog.js";
import {
	type JsonValue,
	parseQuoteScenario,
} from "../packages/pricing/src/json.js";
import { stateHashOf } from "../packages/pricing/src/state.js";

const AT = "2026-01-01T00:00:00Z";
const HORIZON = "2026-01-31T23:59:59Z";
const INTERVAL = {
	start: "2025-01-01T00:00:00Z",
	end: "2027-01-01T00:00:00Z",
};
const EVIDENCE = {
	source: "fixture://provider-commercial-terms",
	observedAt: AT,
	validFrom: AT,
	validUntil: "2027-01-01T00:00:00Z",
	evidenceHash: `sha256:${"0".repeat(64)}`,
};

function money(decimal: string): JsonValue {
	return { decimal, currency: "USD" };
}

export function usage(
	dimension: string,
	decimal: string,
	unit: string,
): JsonValue {
	return {
		dimension,
		quantity: { decimal, unit },
		observedAt: AT,
		uniqueValues: [],
	};
}

export function workload(
	agreementRef: string,
	measurements: JsonValue[],
): JsonValue {
	return {
		productRef: "sandbox",
		agreementRef,
		direction: "add",
		quantities: {},
		usage: measurements,
		attributes: {},
	};
}

export function perUnitCharge(
	id: string,
	dimension: string,
	decimal: string,
): JsonValue {
	return {
		base: {
			id,
			selectors: {},
			fallback: false,
			invoiceBehavior: "itemized",
		},
		usage: {
			dimension,
			timing: "arrears",
			perUnit: money(decimal),
		},
	};
}

export function rehashScenario(scenario: QuoteScenario): QuoteScenario {
	if (scenario.catalog === undefined || scenario.state === undefined)
		throw new Error("scenario requires catalog and state");
	scenario.catalog.catalogHash = catalogHashOf(scenario.catalog);
	scenario.pricingCatalogHash = scenario.catalog.catalogHash;
	scenario.state.stateHash = stateHashOf(scenario.state);
	return scenario;
}

export function makeScenario({
	charges,
	candidate,
}: {
	charges: JsonValue[];
	candidate: JsonValue[];
}): QuoteScenario {
	const scenario = parseQuoteScenario({
		action: "place",
		at: AT,
		horizon: HORIZON,
		pricingCatalogHash: "",
		catalog: {
			schema: "hobo.pricing.catalog/v1",
			catalogHash: "",
			products: [
				{
					id: "sandbox",
					providerId: "sandbox",
					meters: [{ dimension: "minute", unit: "minute", aggregation: "sum" }],
				},
			],
			rateCards: [
				{
					id: "card-v1",
					version: "1",
					currency: "USD",
					effective: INTERVAL,
					charges,
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
					id: "agreement-a",
					tenantId: "tenant-a",
					providerAccountRef: "account-a",
					productId: "sandbox",
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
						fee: money("0"),
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
					source: "fixture://state",
					observedAt: AT,
					validUntil: "2027-01-01T00:00:00Z",
					detail: "complete fixture",
				},
			],
		},
		baseline: [],
		candidate,
		sourceProviderAgreementIds: [],
		options: {
			allowNewProviderAgreement: false,
			allowCancellation: false,
			amortization: "provider-actual",
			allocationConvention: "marginal-consume",
			allocationForecast: [],
		},
	});
	if (scenario === undefined) throw new Error("invalid test scenario fixture");
	return rehashScenario(scenario);
}
