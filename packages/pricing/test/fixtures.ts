import { clone } from "@bufbuild/protobuf";
import {
	type QuoteScenario,
	QuoteScenarioSchema,
} from "../src/_generated/pricing_pb.js";
import { catalogHashOf } from "../src/catalog.js";
import { type JsonValue, parseQuoteScenario } from "../src/json.js";
import { stateHashOf } from "../src/state.js";

export const AT = "2026-01-01T00:00:00Z";
export const HORIZON = "2026-01-31T23:59:59Z";
export const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;

const INTERVAL = {
	start: "2025-01-01T00:00:00Z",
	end: "2027-01-01T00:00:00Z",
};

const EVIDENCE = {
	source: "fixture://provider-commercial-terms",
	observedAt: AT,
	validFrom: AT,
	validUntil: "2027-01-01T00:00:00Z",
	evidenceHash: ZERO_DIGEST,
};

export function money(decimal: string, currency = "USD"): JsonValue {
	return { decimal, currency };
}

export function quantity(decimal: string, unit: string): JsonValue {
	return { decimal, unit };
}

export function usage(
	dimension: string,
	decimal: string,
	unit: string,
	uniqueValues: string[] = [],
): JsonValue {
	return {
		dimension,
		quantity: quantity(decimal, unit),
		observedAt: AT,
		uniqueValues,
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
			timing: "advance",
			perUnit: money(decimal),
		},
	};
}

export function fixedCharge(id: string, decimal: string): JsonValue {
	return {
		base: {
			id,
			selectors: {},
			fallback: false,
			invoiceBehavior: "itemized",
		},
		fixed: {
			cadence: "monthly",
			timing: "advance",
			amount: money(decimal),
			proration: "none",
		},
	};
}

export function allowanceState(
	id: string,
	remaining: string,
	used: string,
	dimension = "minute",
	unit = "minute",
): JsonValue {
	return {
		grant: {
			id,
			tenantId: "tenant-a",
			included: quantity("1000", unit),
			scope: {
				productIds: [],
				rateCardIds: [],
				chargeIds: [],
				dimensions: [dimension],
			},
			recurrence: { interval: "monthly" },
			effective: INTERVAL,
			rollover: { max: "0", reset: true },
			exhaustion: "bill-overage",
			priority: 0,
			evidence: EVIDENCE,
		},
		remaining: quantity(remaining, unit),
		used: quantity(used, unit),
	};
}

export function creditState(
	id: string,
	kind: "zero" | "acquisition",
	priority: number,
): JsonValue {
	return {
		grant: {
			id,
			tenantId: "tenant-a",
			category: kind === "acquisition" ? "paid" : "promotional",
			faceValue: { money: money("10") },
			economicBasis:
				kind === "acquisition"
					? { kind, acquisitionAmount: money("9") }
					: { kind },
			scope: {
				productIds: [],
				rateCardIds: [],
				chargeIds: [],
				dimensions: [],
			},
			effective: INTERVAL,
			recurrence: { interval: "none" },
			rollover: { max: "0", reset: true },
			priority,
			evidence: EVIDENCE,
		},
		remaining: { money: money("10") },
		used: { money: money("0") },
		remainingBasis: money(kind === "acquisition" ? "9" : "0"),
		usedBasis: money("0"),
	};
}

export function commitmentState(): JsonValue {
	return {
		commitment: {
			id: "commitment-a",
			tenantId: "tenant-a",
			kind: "spend",
			amount: { money: money("100") },
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
		remaining: { money: money("60") },
		used: { money: money("40") },
	};
}

type ScenarioFixture = {
	charges: JsonValue[];
	meters?: JsonValue[];
	baseline?: JsonValue[];
	candidate?: JsonValue[];
	allowances?: JsonValue[];
	credits?: JsonValue[];
	commitments?: JsonValue[];
};

export function makeScenario({
	charges,
	meters = [
		{
			dimension: "minute",
			unit: "minute",
			aggregation: "sum",
		},
	],
	baseline = [],
	candidate = [],
	allowances = [],
	credits = [],
	commitments = [],
}: ScenarioFixture): QuoteScenario {
	const scenario = parseQuoteScenario({
		action: "place",
		at: AT,
		horizon: HORIZON,
		pricingCatalogHash: "",
		catalog: {
			schema: "hobo.pricing.catalog/v1",
			catalogHash: "",
			products: [{ id: "sandbox", providerId: "sandbox", meters }],
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
			allowances,
			credits,
			commitments,
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
		baseline,
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

export function rehashScenario(scenario: QuoteScenario): QuoteScenario {
	if (scenario.catalog === undefined || scenario.state === undefined) {
		throw new Error("test scenario requires catalog and state");
	}
	scenario.catalog.catalogHash = catalogHashOf(scenario.catalog);
	scenario.pricingCatalogHash = scenario.catalog.catalogHash;
	scenario.state.stateHash = stateHashOf(scenario.state);
	return scenario;
}

export function cloneScenario(scenario: QuoteScenario): QuoteScenario {
	return clone(QuoteScenarioSchema, scenario);
}
