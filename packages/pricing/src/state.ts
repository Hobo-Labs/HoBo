import { clone, toJson } from "@bufbuild/protobuf";
import {
	type EffectiveInterval,
	type Evidence,
	type FinancialStateView,
	FinancialStateViewSchema,
	type GrantScope,
	type QuoteScenario,
} from "./_generated/pricing_pb.js";
import { stableHash } from "./json.js";
import type { PricingRejectionCode } from "./types.js";

const UTC_PATTERN =
	/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class PricingFault extends Error {
	readonly code: PricingRejectionCode;

	constructor(code: PricingRejectionCode, message: string) {
		super(message);
		this.name = "PricingFault";
		this.code = code;
	}
}

export function parseUtc(value: string, path: string): number {
	if (!UTC_PATTERN.test(value)) {
		throw new PricingFault(
			"INVALID_PRICING_INPUT",
			`${path} must be an explicit UTC timestamp`,
		);
	}
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) {
		throw new PricingFault(
			"INVALID_PRICING_INPUT",
			`${path} is not a valid timestamp`,
		);
	}
	return parsed;
}

export function intervalCovers(
	interval: EffectiveInterval,
	at: string,
	horizon: string,
): boolean {
	const start = parseUtc(interval.start, "interval.start");
	const end =
		interval.end === undefined
			? Number.POSITIVE_INFINITY
			: parseUtc(interval.end, "interval.end");
	return start <= parseUtc(at, "at") && end >= parseUtc(horizon, "horizon");
}

function validateEvidence(
	evidence: Evidence | undefined,
	at: string,
	horizon: string,
	path: string,
): void {
	if (evidence === undefined) {
		throw new PricingFault(
			"INCOMPLETE_FINANCIAL_STATE",
			`${path} evidence is missing`,
		);
	}
	if (
		parseUtc(evidence.observedAt, `${path}.observedAt`) > parseUtc(at, "at") ||
		parseUtc(evidence.validFrom, `${path}.validFrom`) > parseUtc(at, "at") ||
		parseUtc(evidence.validUntil, `${path}.validUntil`) <
			parseUtc(horizon, "horizon")
	) {
		throw new PricingFault(
			"STALE_OBSERVATION",
			`${path} evidence does not cover the quote horizon`,
		);
	}
}

export function stateHashOf(state: FinancialStateView): string {
	const hashed = clone(FinancialStateViewSchema, state);
	hashed.stateHash = "";
	return stableHash(
		toJson(FinancialStateViewSchema, hashed, {
			alwaysEmitImplicit: true,
		}),
	);
}

export function validateScenarioState(scenario: QuoteScenario): void {
	const catalog = scenario.catalog;
	const state = scenario.state;
	if (catalog === undefined || state === undefined) {
		throw new PricingFault(
			"INCOMPLETE_FINANCIAL_STATE",
			"catalog and financial state are required",
		);
	}
	if (
		!new Set(["place", "dispatch", "rebalance", "migrate", "cancel"]).has(
			scenario.action,
		)
	) {
		throw new PricingFault("INVALID_PRICING_INPUT", "unknown quote action");
	}
	const at = parseUtc(scenario.at, "scenario.at");
	const horizon = parseUtc(scenario.horizon, "scenario.horizon");
	if (horizon < at) {
		throw new PricingFault(
			"INVALID_PRICING_INPUT",
			"quote horizon precedes quote time",
		);
	}
	if (catalog.schema !== "hobo.pricing.catalog/v1") {
		throw new PricingFault(
			"INVALID_PRICING_INPUT",
			"unknown pricing catalog schema",
		);
	}
	if (
		!DIGEST_PATTERN.test(catalog.catalogHash) ||
		scenario.pricingCatalogHash !== catalog.catalogHash
	) {
		throw new PricingFault(
			"CATALOG_HASH_MISMATCH",
			"scenario and catalog hashes differ",
		);
	}
	if (state.schema !== "hobo.pricing/v1") {
		throw new PricingFault(
			"INVALID_PRICING_INPUT",
			"unknown financial state schema",
		);
	}
	const allowPartial = scenario.options?.allowPartialFinancialState === true;
	if (state.completeness !== "complete" && !allowPartial) {
		throw new PricingFault(
			"INCOMPLETE_FINANCIAL_STATE",
			"financial state must be complete hobo.pricing/v1",
		);
	}
	if (!DIGEST_PATTERN.test(state.stateHash)) {
		throw new PricingFault(
			"STATE_HASH_MISMATCH",
			"invalid financial state hash",
		);
	}
	if (parseUtc(state.asOf, "state.asOf") > at) {
		throw new PricingFault(
			"STALE_OBSERVATION",
			"financial state is from the future",
		);
	}
	if (state.observations.length === 0) {
		throw new PricingFault(
			"INCOMPLETE_FINANCIAL_STATE",
			"financial state has no observations",
		);
	}
	for (const [index, observation] of state.observations.entries()) {
		if (
			parseUtc(observation.observedAt, `observations.${index}.observedAt`) >
				at ||
			parseUtc(observation.validUntil, `observations.${index}.validUntil`) <
				horizon
		) {
			throw new PricingFault(
				"STALE_OBSERVATION",
				`observation ${index} does not cover the quote horizon`,
			);
		}
	}
	for (const agreement of state.agreements) {
		if (
			agreement.tenantId !== state.tenantId ||
			agreement.billingPeriod?.timeZone !== "UTC"
		) {
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				`agreement ${agreement.id} has a tenant or non-UTC billing-period mismatch`,
			);
		}
		if (
			agreement.term === undefined ||
			!intervalCovers(agreement.term, scenario.at, scenario.horizon)
		) {
			throw new PricingFault(
				"STALE_OBSERVATION",
				`agreement ${agreement.id} term does not cover the quote horizon`,
			);
		}
		validateEvidence(
			agreement.evidence,
			scenario.at,
			scenario.horizon,
			`agreement.${agreement.id}`,
		);
	}
	for (const allowance of state.allowances) {
		validateEvidence(
			allowance.grant?.evidence,
			scenario.at,
			scenario.horizon,
			`allowance.${allowance.grant?.id ?? "unknown"}`,
		);
		if (
			allowance.grant?.effective === undefined ||
			!intervalCovers(allowance.grant.effective, scenario.at, scenario.horizon)
		) {
			throw new PricingFault(
				"STALE_OBSERVATION",
				`allowance ${allowance.grant?.id ?? "unknown"} is not effective`,
			);
		}
	}
	for (const credit of state.credits) {
		validateEvidence(
			credit.grant?.evidence,
			scenario.at,
			scenario.horizon,
			`credit.${credit.grant?.id ?? "unknown"}`,
		);
		if (
			credit.grant?.effective === undefined ||
			!intervalCovers(credit.grant.effective, scenario.at, scenario.horizon)
		) {
			throw new PricingFault(
				"STALE_OBSERVATION",
				`credit ${credit.grant?.id ?? "unknown"} is not effective`,
			);
		}
	}
	for (const commitment of state.commitments) {
		validateEvidence(
			commitment.commitment?.evidence,
			scenario.at,
			scenario.horizon,
			`commitment.${commitment.commitment?.id ?? "unknown"}`,
		);
		if (
			commitment.commitment?.term === undefined ||
			!intervalCovers(commitment.commitment.term, scenario.at, scenario.horizon)
		) {
			throw new PricingFault(
				"STALE_OBSERVATION",
				`commitment ${commitment.commitment?.id ?? "unknown"} is not effective`,
			);
		}
	}
}

export function workingState(state: FinancialStateView): FinancialStateView {
	const working = clone(FinancialStateViewSchema, state);
	working.allowances.sort(
		(left, right) =>
			(left.grant?.priority ?? 0) - (right.grant?.priority ?? 0) ||
			(left.grant?.effective?.end ?? "9999").localeCompare(
				right.grant?.effective?.end ?? "9999",
			) ||
			(left.grant?.id ?? "").localeCompare(right.grant?.id ?? ""),
	);
	working.credits.sort(
		(left, right) =>
			(left.grant?.priority ?? 0) - (right.grant?.priority ?? 0) ||
			(left.grant?.effective?.end ?? "9999").localeCompare(
				right.grant?.effective?.end ?? "9999",
			) ||
			(left.grant?.id ?? "").localeCompare(right.grant?.id ?? ""),
	);
	working.commitments.sort((left, right) =>
		(left.commitment?.id ?? "").localeCompare(right.commitment?.id ?? ""),
	);
	return working;
}

export function scopeMatches(
	scope: GrantScope | undefined,
	productId: string,
	rateCardId: string,
	chargeId: string,
	dimension: string,
): boolean {
	return (
		((scope?.productIds.length ?? 0) === 0 ||
			scope?.productIds.includes(productId) === true) &&
		((scope?.rateCardIds.length ?? 0) === 0 ||
			scope?.rateCardIds.includes(rateCardId) === true) &&
		((scope?.chargeIds.length ?? 0) === 0 ||
			scope?.chargeIds.includes(chargeId) === true) &&
		((scope?.dimensions.length ?? 0) === 0 ||
			scope?.dimensions.includes(dimension) === true)
	);
}
