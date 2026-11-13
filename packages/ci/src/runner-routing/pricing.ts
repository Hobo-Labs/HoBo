/**
 * Runner financial models, compiled for the `@hobo/pricing` quote engine.
 *
 * Runner routing never multiplies a rate by a duration itself. A model becomes a
 * catalog product with a rate card (usage per runner minute, the plan fee as
 * a fixed monthly charge) and an allowance grant for the included minutes;
 * the member's commercial state says whether the account exists and how much
 * of the allowance is left. The engine rates the month with and without the
 * job, and the difference is what the job really costs: nothing while free
 * minutes remain, the whole plan fee if taking the job means opening the
 * account.
 */

import {
	catalogHashOf,
	parseDecimal,
	parseQuoteScenario,
	type QuoteScenario,
	stateHashOf,
} from "@hobo/pricing";
import type { RunnerFinancialModel } from "./models.js";

const RUNNER_MINUTE = "runner-minute";
/** Fixed-charge quantity: 1 while the plan is paid for, 0 before it is opened. */
const PLAN = "plan";
const USD = "USD";
const ZERO_HASH = `sha256:${"0".repeat(64)}`;

const MICROS_SCALE = 6;

/** Whole microdollars, rounded up: a bound must never understate a charge. */
export function usdToMicrosCeil(decimal: string): number | undefined {
	const parsed = parseDecimal(decimal);
	if (parsed === undefined || parsed.coefficient < 0n) return undefined;
	const shift = MICROS_SCALE - parsed.scale;
	let micros: bigint;
	if (shift >= 0) micros = parsed.coefficient * 10n ** BigInt(shift);
	else {
		const divisor = 10n ** BigInt(-shift);
		micros = parsed.coefficient / divisor;
		if (parsed.coefficient % divisor !== 0n) micros += 1n;
	}
	return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : undefined;
}

const MINUTE_METER = {
	dimension: RUNNER_MINUTE,
	unit: "minute",
	aggregation: "sum",
} as const;
/** Each job is rounded up to a whole minute before it is rated. */
const WHOLE_MINUTE_CEILING = {
	scope: "event",
	multiple: "1",
	mode: "ceil",
} as const;

/** What is known about one member's account when a job is priced. */
export type RunnerCommercialState = Readonly<{
	/** The provider account exists and its plan fee is already being paid. */
	subscribed: boolean;
	/**
	 * Included minutes left this billing month. Absent means the full monthly
	 * grant; a provider whose usage has been observed supplies the remainder.
	 */
	allowanceRemainingMinutes?: string;
}>;

export type RunnerQuoteRequest = Readonly<{
	model: RunnerFinancialModel;
	state: RunnerCommercialState;
	tenantId: string;
	/** Reserved runner minutes, startup included. */
	minutes: number;
	/** Authoritative current time, RFC 3339 UTC. */
	at: string;
}>;

function monthStart(at: string): string {
	const date = new Date(at);
	return new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
	).toISOString();
}

function nextMonthStart(at: string): string {
	const date = new Date(at);
	return new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
	).toISOString();
}

function compact(iso: string): string {
	return iso.replace(".000Z", "Z");
}

/**
 * The scenario the dispatcher rates for one job on one member. Throws only on
 * a malformed request; an unpriceable member is the engine's rejection.
 */
export function runnerQuoteScenario(
	request: RunnerQuoteRequest,
): QuoteScenario {
	const { model, state, at } = request;
	if (!Number.isFinite(Date.parse(at)))
		throw new TypeError("runner quote requires an authoritative current time");
	if (!Number.isSafeInteger(request.minutes) || request.minutes < 1)
		throw new TypeError("runner quote requires whole positive minutes");
	const periodStart = compact(monthStart(at));
	const periodEnd = compact(nextMonthStart(at));
	const interval = {
		start: model.evidence.observedAt,
		end: model.evidence.validUntil,
	};
	const evidence = {
		source: model.evidence.source,
		observedAt: model.evidence.observedAt,
		validFrom: model.evidence.observedAt,
		validUntil: model.evidence.validUntil,
		evidenceHash: ZERO_HASH,
	};
	const rateCardId = `${model.id}-rates`;
	const scope = {
		productIds: [model.id],
		rateCardIds: [rateCardId],
		chargeIds: ["usage"],
		dimensions: [RUNNER_MINUTE],
	};
	const allowanceId = `${model.id}-included-minutes`;
	const allowance =
		model.monthlyFreeMinutes === undefined
			? undefined
			: {
					id: allowanceId,
					tenantId: request.tenantId,
					included: { decimal: model.monthlyFreeMinutes, unit: "minute" },
					scope,
					recurrence: { interval: "monthly" },
					effective: { start: periodStart, end: periodEnd },
					rollover: { max: "0", reset: true },
					exhaustion: "overage",
					priority: 0,
					evidence,
				};
	const scenario = parseQuoteScenario({
		action: "dispatch",
		at,
		// A job is rated against the month it lands in, never past the evidence.
		horizon: compact(
			new Date(
				Math.min(
					Date.parse(periodEnd) - 1000,
					Date.parse(model.evidence.validUntil) - 1000,
				),
			).toISOString(),
		),
		pricingCatalogHash: "",
		catalog: {
			schema: "hobo.pricing.catalog/v1",
			catalogHash: "",
			products: [
				{
					id: model.id,
					providerId: model.provider,
					meters: [
						model.billing === "per-minute-ceil"
							? { ...MINUTE_METER, rounding: WHOLE_MINUTE_CEILING }
							: MINUTE_METER,
					],
				},
			],
			rateCards: [
				{
					id: rateCardId,
					version: model.evidence.observedAt.slice(0, 10),
					currency: USD,
					effective: interval,
					charges: [
						...(model.monthlyFeeUsd === undefined
							? []
							: [
									{
										base: {
											id: "plan",
											selectors: {},
											fallback: false,
											invoiceBehavior: "itemized",
										},
										fixed: {
											cadence: "monthly",
											timing: "advance",
											amount: { decimal: model.monthlyFeeUsd, currency: USD },
											quantityDimension: PLAN,
											proration: "none",
										},
									},
								]),
						{
							base: {
								id: "usage",
								selectors: {},
								fallback: false,
								invoiceBehavior: "itemized",
							},
							usage: {
								dimension: RUNNER_MINUTE,
								timing: "arrears",
								perUnit: { decimal: model.usdPerMinute, currency: USD },
							},
						},
					],
				},
			],
			allowances: allowance === undefined ? [] : [allowance],
			credits: [],
			commitments: [],
		},
		state: {
			schema: "hobo.pricing/v1",
			view: "commercial-state",
			tenantId: request.tenantId,
			seq: "1",
			stateHash: "",
			asOf: at,
			agreements: [
				{
					id: model.id,
					tenantId: request.tenantId,
					providerAccountRef: model.id,
					productId: model.id,
					rateSchedule: [{ rateCardId, effective: interval }],
					// The rate schedule is always ratable. Whether the plan is being paid
					// for is its quantity, so opening it shows up as incremental cost.
					status: "active",
					term: interval,
					billingPeriod: {
						interval: "monthly",
						anchor: periodStart,
						timeZone: "UTC",
					},
					quantities: { [PLAN]: state.subscribed ? "1" : "0" },
					cancellation: {
						allowed: false,
						refund: "none",
						fee: { decimal: "0", currency: USD },
						notice: "",
					},
					evidence,
				},
			],
			allowances:
				allowance === undefined
					? []
					: [
							{
								grant: allowance,
								remaining: {
									decimal:
										state.allowanceRemainingMinutes ??
										model.monthlyFreeMinutes ??
										"0",
									unit: "minute",
								},
								used: { decimal: "0", unit: "minute" },
							},
						],
			credits: [],
			commitments: [],
			periodActuals: [],
			completeness: "complete",
			observations: [
				{
					source: model.evidence.source,
					observedAt: model.evidence.observedAt,
					validUntil: model.evidence.validUntil,
					detail: model.evidence.note,
				},
			],
		},
		baseline: [],
		candidate: [
			{
				productRef: model.id,
				agreementRef: model.id,
				direction: "add",
				quantities: state.subscribed ? {} : { [PLAN]: "1" },
				usage: [
					{
						dimension: RUNNER_MINUTE,
						quantity: { decimal: String(request.minutes), unit: "minute" },
						observedAt: at,
						uniqueValues: [],
					},
				],
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
	});
	if (
		scenario === undefined ||
		scenario.catalog === undefined ||
		scenario.state === undefined
	)
		throw new TypeError(`runner model ${model.id} is not a pricing scenario`);
	scenario.catalog.catalogHash = catalogHashOf(scenario.catalog);
	scenario.pricingCatalogHash = scenario.catalog.catalogHash;
	scenario.state.stateHash = stateHashOf(scenario.state);
	return scenario;
}
