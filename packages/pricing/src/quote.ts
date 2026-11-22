import { clone, create } from "@bufbuild/protobuf";
import {
	type Money,
	MoneySchema,
	type PricingRejected,
	PricingRejectedSchema,
	type QuoteAmounts,
	QuoteAmountsSchema,
	type QuoteScenario,
	type QuoteVector,
	QuoteVectorSchema,
} from "./_generated/pricing_pb.js";
import { hasBaselineCharges } from "./agreement-status.js";
import { validateBillingPeriods } from "./billing-period.js";
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
import { type RatedSnapshot, rateSnapshot } from "./rating.js";
import {
	PricingFault,
	stateHashOf,
	validateFinancialBalances,
	validateFinancialIdentities,
	validateFinancialSourceIds,
	validateFinancialSourceValues,
	validateGrantScopes,
	validateScenarioState,
} from "./state.js";
import { validateScenarioTimes } from "./time-order.js";
import type { PricingRejectionCode, QuoteResult } from "./types.js";

const EMPTY_CAPABILITY_HASH = `sha256:${"0".repeat(64)}`;
export const RATING_ALGORITHM_VERSION = "pricing-rating/v1";

export function quoteHashOf(quote: QuoteVector): string {
	const unhashed = clone(QuoteVectorSchema, quote);
	unhashed.quoteHash = "";
	return stableHash(quoteVectorToJson(unhashed));
}

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

function validateAgreementAvailability(scenario: QuoteScenario): void {
	const referenced = new Set(
		[...scenario.baseline, ...scenario.candidate].map(
			(workload) => workload.agreementRef,
		),
	);
	for (const agreement of scenario.state?.agreements ?? []) {
		const used = referenced.has(agreement.id);
		if (hasBaselineCharges(agreement.status)) continue;
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

export function quoteScenario(scenario: QuoteScenario): QuoteResult {
	if (!isSupportedPricingRealm()) return unsupportedRealm();
	if (!isBoundedPricingInput(scenario))
		return rejection(
			"INVALID_PRICING_INPUT",
			"request is not bounded pricing data",
		);
	try {
		validateScenarioTimes(scenario);
		validateScenarioState(scenario);
		validateFinancialIdentities(scenario.state);
		if (scenario.state !== undefined) {
			validateFinancialBalances(scenario.state);
			validateGrantScopes(scenario.state);
			validateFinancialSourceIds(scenario.state);
			validateFinancialSourceValues(scenario.state);
		}
		validateBillingPeriods(scenario);
		validateAgreementAvailability(scenario);
		validateQuoteOptions(scenario);
		if (scenario.action === "destroy") {
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
		} else if (scenario.destroyCancelsAgreement !== undefined)
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"destroy cancellation terms require a destroy scenario",
			);
		if (
			scenario.action === "rebalance" ||
			scenario.action === "migrate" ||
			scenario.action === "cancel" ||
			scenario.sourceProviderAgreementIds.length > 0 ||
			scenario.candidate.some((candidate) => candidate.direction === "remove")
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
		const baseline = rateSnapshot(scenario, scenario.baseline);
		const candidate = rateSnapshot(scenario, [
			...scenario.baseline,
			...scenario.candidate,
		]);
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
		const informationalPartial = state.completeness === "partial";
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
			ratingAlgorithmVersion: RATING_ALGORITHM_VERSION,
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
			quoteHash: quoteHashOf(initial),
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

export function quoteScenarioJson(value: JsonValue | undefined): QuoteResult {
	if (!isSupportedPricingRealm()) return unsupportedRealm();
	const scenario = value === undefined ? undefined : parseQuoteScenario(value);
	if (scenario === undefined) {
		return rejection(
			"INVALID_PRICING_INPUT",
			"request is not a valid QuoteScenario",
		);
	}
	return quoteScenario(scenario);
}
