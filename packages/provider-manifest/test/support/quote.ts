import { toJson } from "@bufbuild/protobuf";
import {
	isQuoteVector,
	type JsonValue,
	PricingCatalogSchema,
	parseQuoteScenario,
	quoteScenario,
	stateHashOf,
} from "@hobo/pricing";
import type { BillingLowering } from "../../src/index.js";

const AT = "2026-11-15T00:00:00Z";
const HORIZON = "2026-12-14T23:59:59Z";
const TERM = { start: "2026-11-01T00:00:00Z", end: "2027-11-01T00:00:00Z" };
const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;

export type Usage = Readonly<Record<string, [quantity: string, unit: string]>>;

/**
 * Rate one plan of a lowered manifest through the real `@hobo/pricing`
 * kernel and return the period's billed total with that usage placed.
 */
export function billed(
	lowering: BillingLowering,
	productId: string,
	planId: string,
	usage: Usage = {},
	quantities: Readonly<Record<string, string>> = {},
): string {
	const plan = lowering.rated.find(
		(entry) => entry.productId === productId && entry.planId === planId,
	);
	if (plan === undefined) throw new Error(`${productId}/${planId} is unrated`);
	const catalog = toJson(PricingCatalogSchema, lowering.catalog, {
		alwaysEmitImplicit: true,
	});
	const scenarioJson: JsonValue = {
		action: "place",
		at: AT,
		horizon: HORIZON,
		pricingCatalogHash: lowering.catalog.catalogHash,
		catalog,
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
					productId: plan.productRef,
					rateSchedule: [{ rateCardId: plan.rateCardId, effective: TERM }],
					status: "active",
					term: TERM,
					billingPeriod: { interval: "monthly", anchor: AT, timeZone: "UTC" },
					quantities: {},
					cancellation: {
						allowed: false,
						refund: "none",
						fee: { decimal: "0", currency: "USD" },
						notice: "",
					},
					evidence: {
						source: "fixture://provider-manifest",
						observedAt: AT,
						validFrom: AT,
						validUntil: TERM.end,
						evidenceHash: ZERO_DIGEST,
					},
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
					validUntil: TERM.end,
					detail: "complete fixture",
				},
			],
		},
		baseline: [],
		candidate: [
			{
				productRef: plan.productRef,
				agreementRef: "agreement-a",
				direction: "add",
				quantities: { ...quantities },
				usage: Object.entries(usage).map(([dimension, [decimal, unit]]) => ({
					dimension,
					quantity: { decimal, unit },
					observedAt: AT,
					uniqueValues: [],
				})),
				attributes: {},
			},
		],
		sourceProviderAgreementIds: [],
		options: {
			allowNewProviderAgreement: false,
			allowCancellation: false,
			amortization: "provider-actual",
			allocationConvention: "marginal-consume",
			allocationForecast: [],
		},
	};
	const scenario = parseQuoteScenario(scenarioJson);
	if (scenario?.state === undefined) throw new Error("scenario did not parse");
	scenario.state.stateHash = stateHashOf(scenario.state);
	const result = quoteScenario(scenario);
	if (!isQuoteVector(result))
		throw new Error(`${result.code}: ${result.message}`);
	return result.candidate?.billed?.decimal ?? "";
}
