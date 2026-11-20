import { create } from "@bufbuild/protobuf";
import {
	type Money,
	MoneySchema,
	type PricingRejected,
	PricingRejectedSchema,
	type QuoteAmounts,
	QuoteAmountsSchema,
	type QuoteScenario,
	QuoteVectorSchema,
} from "./_generated/pricing_pb.js";
import { hasV2BaselineCharges } from "./agreement-status.js";
import { validateV2BillingPeriods } from "./billing-period.js";
import { catalogHashOf } from "./catalog.js";
import {
	addDecimal,
	DECIMAL_ZERO,
	parseDecimal as decimalParser,
	formatDecimal as decimalText,
	maxDecimal,
	subtractDecimal,
} from "./decimal.js";
import {
	isBoundedPricingInput,
	isSupportedPricingRealm,
	type JsonValue,
	parseQuoteScenario,
	quoteVectorToJson,
	stableHash,
} from "./json.js";
import {
	codeUnitPricingOrder,
	legacyPricingOrder,
	type PricingOrder,
} from "./ordering.js";
import { type RatedSnapshot, rateSnapshot } from "./rating.js";
import {
	EXACT_TIME,
	exactPricingTimeOrder,
	LEGACY_TIME,
	PricingFault,
	stateHashOf,
	type TemporalPolicy,
	validateScenarioState,
	validateV2FinancialBalances,
	validateV2FinancialIdentities,
	validateV2GrantScopes,
} from "./state.js";
import {
	legacyPricingTimeOrder,
	type PricingTimeOrder,
	utcPricingTimeOrder,
	validateV2ScenarioTimes,
} from "./time-order.js";
import type { PricingRejectionCode, QuoteResult } from "./types.js";

export type RatingAlgorithmVersion =
	| "pricing-rating/v1"
	| "pricing-rating/v2"
	| "pricing-rating/v3"
	| "pricing-rating/v4"
	| "pricing-rating/v5"
	| "pricing-rating/v6"
	| "pricing-rating/v7"
	| "pricing-rating/v8"
	| "pricing-rating/v9";
export type RatingOptions = { ratingAlgorithmVersion?: RatingAlgorithmVersion };
const RATING_ALGORITHM_VERSION = "pricing-rating/v9";
const EMPTY_CAPABILITY_HASH = `sha256:${"0".repeat(64)}`;

function unsupportedRealm(): PricingRejected {
	return {
		$typeName: "hobo.pricing.v1.PricingRejected",
		schema: "hobo.pricing.rejected/v1",
		code: "PRICING_REALM_UNSUPPORTED",
		message: "pricing requires an unchanged standard Object.prototype",
		unpriced: [],
		rejectedCandidates: [],
	};
}

function rejection(
	code: PricingRejectionCode,
	message: string,
	candidateRefs: readonly string[] = [],
): PricingRejected {
	return create(PricingRejectedSchema, {
		schema: "hobo.pricing.rejected/v1",
		code,
		message,
		unpriced: [],
		rejectedCandidates: candidateRefs.map((candidateRef) => ({
			candidateRef,
			code,
			reason: message,
		})),
	});
}

function quoteAmounts(snapshot: RatedSnapshot): QuoteAmounts {
	return create(QuoteAmountsSchema, {
		billed: snapshot.billed,
		dueNow: snapshot.dueNow,
		effective: snapshot.effective,
	});
}

function subtractMoney(
	candidate: Money | undefined,
	baseline: Money | undefined,
	currency: string,
	clampAtZero = false,
): Money {
	if (candidate === undefined || baseline === undefined) {
		throw new PricingFault(
			"INCOMPLETE_FINANCIAL_STATE",
			"quote amount is missing",
		);
	}
	const candidateDecimal = scenarioDecimal(candidate.decimal);
	const baselineDecimal = scenarioDecimal(baseline.decimal);
	const delta = subtractDecimal(candidateDecimal, baselineDecimal);
	return create(MoneySchema, {
		decimal: decimalText(clampAtZero ? maxDecimal(delta, DECIMAL_ZERO) : delta),
		currency,
	});
}

function scenarioDecimal(value: string) {
	const parsed = decimalParser(value);
	if (parsed === undefined) {
		throw new PricingFault("INVALID_PRICING_INPUT", "invalid rated decimal");
	}
	return parsed;
}

function migrationAndTerminationTotal(
	scenario: QuoteScenario,
	currency: string,
): Money {
	if (scenario.options?.allowCancellation !== true) {
		return create(MoneySchema, { decimal: "0", currency });
	}
	if (scenario.action !== "migrate" && scenario.action !== "cancel") {
		return create(MoneySchema, { decimal: "0", currency });
	}
	let total = DECIMAL_ZERO;
	for (const delta of scenario.candidate) {
		if (delta.direction !== "remove") continue;
		const agreement = scenario.state?.agreements.find(
			(entry) => entry.id === delta.agreementRef,
		);
		const fee = agreement?.cancellation?.fee;
		if (fee === undefined || fee.currency !== currency) continue;
		const parsed = decimalParser(fee.decimal);
		if (parsed === undefined) {
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"cancellation fee is not a decimal",
			);
		}
		total = addDecimal(total, parsed);
	}
	return create(MoneySchema, { decimal: decimalText(total), currency });
}

function validateV2AgreementAvailability(scenario: QuoteScenario): void {
	const referenced = new Set(
		[...scenario.baseline, ...scenario.candidate].map(
			(workload) => workload.agreementRef,
		),
	);
	for (const agreement of scenario.state?.agreements ?? []) {
		const used = referenced.has(agreement.id);
		if (hasV2BaselineCharges(agreement.status)) continue;
		if (agreement.status === "trialing") {
			if (used) continue;
			throw new PricingFault(
				"PRICING_AGREEMENT_UNAVAILABLE",
				`trial agreement ${agreement.id} needs an explicit workload to determine its liability`,
			);
		}
		if (agreement.status === "suspended" || agreement.status === "cancelled") {
			if (!used) continue;
			throw new PricingFault(
				"PRICING_AGREEMENT_UNAVAILABLE",
				`agreement ${agreement.id} is not available for pricing`,
			);
		}
		throw new PricingFault(
			"PRICING_AGREEMENT_UNAVAILABLE",
			`agreement ${agreement.id} has an unrecognized status`,
		);
	}
}

function validateQuoteOptions(scenario: QuoteScenario): void {
	const options = scenario.options;
	if (
		options === undefined ||
		!new Set(["provider-actual", "straight-line"]).has(options.amortization) ||
		!new Set(["marginal-consume", "period-proportional"]).has(
			options.allocationConvention,
		)
	) {
		throw new PricingFault(
			"INVALID_PRICING_INPUT",
			"quote options are missing or unsupported",
		);
	}
	if (scenario.action === "cancel" && !options.allowCancellation) {
		throw new PricingFault(
			"CANCELLATION_DENIED",
			"cancellation is default-deny",
		);
	}
	const baselineAgreements = new Set(
		scenario.baseline.map((delta) => delta.agreementRef),
	);
	for (const candidate of scenario.candidate) {
		if (baselineAgreements.has(candidate.agreementRef)) continue;
		const agreement = scenario.state?.agreements.find(
			(entry) => entry.id === candidate.agreementRef,
		);
		if (
			(agreement === undefined || agreement.status === "trialing") &&
			!options.allowNewProviderAgreement
		) {
			throw new PricingFault(
				"NEW_AGREEMENT_DENIED",
				`new provider agreement ${candidate.agreementRef} is default-deny`,
			);
		}
	}
}

export function quoteScenario(
	scenario: QuoteScenario,
	options: RatingOptions = {},
): QuoteResult {
	const version =
		options.ratingAlgorithmVersion === undefined
			? RATING_ALGORITHM_VERSION
			: options.ratingAlgorithmVersion;
	if (
		version !== "pricing-rating/v1" &&
		version !== "pricing-rating/v2" &&
		version !== "pricing-rating/v3" &&
		version !== "pricing-rating/v4" &&
		version !== "pricing-rating/v5" &&
		version !== "pricing-rating/v6" &&
		version !== "pricing-rating/v7" &&
		version !== "pricing-rating/v8" &&
		version !== "pricing-rating/v9"
	)
		return rejection(
			"INVALID_PRICING_INPUT",
			"unknown rating algorithm version",
		);
	return quoteWithOrdering(
		scenario,
		version === "pricing-rating/v1" ? legacyPricingOrder : codeUnitPricingOrder,
		version === "pricing-rating/v1"
			? legacyPricingTimeOrder
			: version === "pricing-rating/v2"
				? utcPricingTimeOrder
				: exactPricingTimeOrder,
		version,
	);
}

export function quoteScenarioV2(scenario: QuoteScenario): QuoteResult {
	return quoteWithOrdering(
		scenario,
		codeUnitPricingOrder,
		utcPricingTimeOrder,
		"pricing-rating/v2",
	);
}

function quoteWithOrdering(
	scenario: QuoteScenario,
	order: PricingOrder,
	timeOrder: PricingTimeOrder,
	ratingAlgorithmVersion: string,
): QuoteResult {
	const strictTimes =
		ratingAlgorithmVersion !== "pricing-rating/v1" &&
		ratingAlgorithmVersion !== "pricing-rating/v2";
	const strictSourceIdentity =
		strictTimes && ratingAlgorithmVersion !== "pricing-rating/v3";
	const strictSourceValues =
		strictSourceIdentity && ratingAlgorithmVersion !== "pricing-rating/v4";
	const selectorPerWorkload =
		strictSourceValues && ratingAlgorithmVersion !== "pricing-rating/v5";
	const rejectAmbiguousLatest =
		ratingAlgorithmVersion === "pricing-rating/v7" ||
		ratingAlgorithmVersion === "pricing-rating/v8" ||
		ratingAlgorithmVersion === "pricing-rating/v9";
	const strictTiers =
		ratingAlgorithmVersion === "pricing-rating/v8" ||
		ratingAlgorithmVersion === "pricing-rating/v9";
	const strictCompleteness = ratingAlgorithmVersion === "pricing-rating/v9";
	const time: TemporalPolicy = strictTimes ? EXACT_TIME : LEGACY_TIME;
	if (!isSupportedPricingRealm()) return unsupportedRealm();
	if (!isBoundedPricingInput(scenario))
		return rejection(
			"INVALID_PRICING_INPUT",
			"request is not bounded pricing data",
		);
	try {
		if (timeOrder === utcPricingTimeOrder) validateV2ScenarioTimes(scenario);
		validateScenarioState(
			scenario,
			time,
			strictSourceIdentity,
			strictSourceValues,
			strictCompleteness,
			timeOrder === utcPricingTimeOrder,
		);
		if (timeOrder === utcPricingTimeOrder) {
			validateV2FinancialIdentities(scenario.state);
			if (scenario.state !== undefined) {
				validateV2FinancialBalances(scenario.state);
				validateV2GrantScopes(scenario.state);
			}
			validateV2BillingPeriods(scenario);
			validateV2AgreementAvailability(scenario);
		}
		validateQuoteOptions(scenario);
		if (timeOrder === utcPricingTimeOrder && scenario.action === "destroy") {
			if (scenario.destroyCancelsAgreement === undefined)
				throw new PricingFault(
					"INCOMPLETE_FINANCIAL_STATE",
					"destroy must explicitly declare whether an agreement is canceled",
				);
			if (
				scenario.destroyCancelsAgreement ||
				scenario.sourceProviderAgreementIds.length > 0 ||
				scenario.candidate.some((candidate) => candidate.direction !== "add")
			)
				throw new PricingFault(
					"PRICING_MODEL_UNSUPPORTED",
					"destroy cancellation and removed-workload costs are not fully modeled",
				);
		} else if (
			timeOrder === utcPricingTimeOrder &&
			scenario.destroyCancelsAgreement !== undefined
		)
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"destroy cancellation terms require a destroy scenario",
			);
		if (
			timeOrder === utcPricingTimeOrder &&
			(scenario.action === "rebalance" ||
				scenario.action === "migrate" ||
				scenario.action === "cancel" ||
				scenario.sourceProviderAgreementIds.length > 0 ||
				scenario.candidate.some(
					(candidate) => candidate.direction === "remove",
				))
		)
			throw new PricingFault(
				"PRICING_MODEL_UNSUPPORTED",
				"source-side changes and their costs are not fully modeled",
			);
		const catalog = scenario.catalog;
		const state = scenario.state;
		const options = scenario.options;
		if (catalog === undefined || state === undefined || options === undefined) {
			throw new PricingFault(
				"INCOMPLETE_FINANCIAL_STATE",
				"state and catalog are required",
			);
		}
		if (catalogHashOf(catalog) !== scenario.pricingCatalogHash) {
			throw new PricingFault(
				"CATALOG_HASH_MISMATCH",
				"catalog content does not match its pinned hash",
			);
		}
		if (stateHashOf(state) !== state.stateHash) {
			throw new PricingFault(
				"STATE_HASH_MISMATCH",
				"financial state content does not match its pinned hash",
			);
		}
		const baseline = rateSnapshot(
			scenario,
			scenario.baseline,
			order,
			timeOrder,
			time,
			strictTimes,
			strictSourceValues,
			selectorPerWorkload,
			rejectAmbiguousLatest,
			strictTiers,
		);
		const candidate = rateSnapshot(
			scenario,
			[...scenario.baseline, ...scenario.candidate],
			order,
			timeOrder,
			time,
			strictTimes,
			strictSourceValues,
			selectorPerWorkload,
			rejectAmbiguousLatest,
			strictTiers,
		);
		if (
			candidate.currency.length === 0 ||
			candidate.currency !== baseline.currency
		) {
			throw new PricingFault(
				"CROSS_CURRENCY",
				"baseline and candidate currencies differ",
			);
		}
		const incremental = create(QuoteAmountsSchema, {
			billed: subtractMoney(
				candidate.billed,
				baseline.billed,
				candidate.currency,
			),
			dueNow: subtractMoney(
				candidate.dueNow,
				baseline.dueNow,
				candidate.currency,
				true,
			),
			effective: subtractMoney(
				candidate.effective,
				baseline.effective,
				candidate.currency,
			),
		});
		const informationalPartial =
			strictCompleteness && state.completeness === "partial";
		const assumptions = [
			"allocatedEffective is advisory and is not a dispatcher v1 input",
			"external provider quotes are evidence only; no live provider call was made",
		];
		if (informationalPartial)
			assumptions.push(
				"financial state is partial; quote is informational only",
			);
		const initial = create(QuoteVectorSchema, {
			schema: "hobo.pricing.quote/v1",
			ratingAlgorithmVersion,
			pricingCatalogHash: scenario.pricingCatalogHash,
			capabilityCatalogHash: EMPTY_CAPABILITY_HASH,
			stateHash: state.stateHash,
			quoteHash: "",
			baseline: quoteAmounts(baseline),
			candidate: quoteAmounts(candidate),
			incremental,
			allocationConvention: options.allocationConvention,
			allocatedEffective: subtractMoney(
				candidate.workloadAllocated,
				baseline.workloadAllocated,
				candidate.currency,
			),
			nominalAtListRate: subtractMoney(
				candidate.nominalAtListRate,
				baseline.nominalAtListRate,
				candidate.currency,
			),
			newObligations: [...candidate.newObligations],
			migrationAndTermination: migrationAndTerminationTotal(
				scenario,
				candidate.currency,
			),
			lines: [...candidate.lines],
			consumption: [...candidate.consumption],
			remainingHeadroom: [...candidate.remainingHeadroom],
			projectedWaste: [...candidate.projectedWaste],
			assumptions,
			unpriced: [],
			eligibility: {
				eligible: !informationalPartial,
				rejectedCandidates: informationalPartial
					? scenario.candidate.map((candidate) => ({
							candidateRef: candidate.agreementRef,
							code: "INCOMPLETE_FINANCIAL_STATE",
							reason:
								"partial financial state cannot authorize automatic selection",
						}))
					: [],
			},
		});
		return create(QuoteVectorSchema, {
			...initial,
			quoteHash: stableHash(quoteVectorToJson(initial)),
		});
	} catch (error) {
		if (error instanceof PricingFault) {
			return rejection(
				error.code,
				error.message,
				scenario.candidate.map((candidate) => candidate.agreementRef),
			);
		}
		return rejection(
			"INVALID_PRICING_INPUT",
			error instanceof Error ? error.message : "unknown pricing failure",
			scenario.candidate.map((candidate) => candidate.agreementRef),
		);
	}
}

export const QuoteEngine = Object.freeze({ quote: quoteScenario });

export function quoteScenarioJson(
	value: JsonValue | undefined,
	options: RatingOptions = {},
): QuoteResult {
	if (!isSupportedPricingRealm()) return unsupportedRealm();
	const scenario = value === undefined ? undefined : parseQuoteScenario(value);
	if (scenario === undefined) {
		return rejection(
			"INVALID_PRICING_INPUT",
			"request is not a valid QuoteScenario",
		);
	}
	return quoteScenario(scenario, options);
}
