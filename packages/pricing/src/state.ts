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
import { compareCodeUnits, type TextComparison } from "./order.js";
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

function parseLegacyUtc(value: string, path: string): number {
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

/** Validate calendar components without silently normalizing impossible dates. */
export function parseUtc(value: string, path: string): number {
	const parsed = parseLegacyUtc(value, path);
	if (new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19))
		throw new PricingFault(
			"INVALID_PRICING_INPUT",
			`${path} is not a valid calendar timestamp`,
		);
	return parsed;
}

/** Compare validated UTC instants without truncating fractional seconds. */
export function compareUtcExact(left: string, right: string): number {
	parseUtc(left, "timestamp");
	parseUtc(right, "timestamp");
	const second = compareCodeUnits(left.slice(0, 19), right.slice(0, 19));
	if (second !== 0) return second;
	const fraction = (value: string) =>
		value[19] === "." ? value.slice(20, -1).replace(/0+$/, "") : "";
	return compareCodeUnits(fraction(left), fraction(right));
}

export type TemporalPolicy = Readonly<{
	parse(value: string, path: string): number;
	compare(left: string, right: string): number;
}>;
export const EXACT_TIME: TemporalPolicy = {
	parse: parseUtc,
	compare: compareUtcExact,
};
export const LEGACY_TIME: TemporalPolicy = {
	parse: parseLegacyUtc,
	compare: (left, right) => Math.sign(Date.parse(left) - Date.parse(right)),
};

function compareChecked(
	left: string,
	leftPath: string,
	right: string,
	rightPath: string,
	time: TemporalPolicy,
): number {
	time.parse(left, leftPath);
	time.parse(right, rightPath);
	return time.compare(left, right);
}

export function intervalCovers(
	interval: EffectiveInterval,
	at: string,
	horizon: string,
	time: TemporalPolicy = EXACT_TIME,
): boolean {
	time.parse(interval.start, "interval.start");
	if (interval.end !== undefined) time.parse(interval.end, "interval.end");
	time.parse(at, "at");
	if (time.compare(interval.start, at) > 0) return false;
	time.parse(horizon, "horizon");
	return (
		time.compare(at, horizon) <= 0 &&
		(interval.end === undefined || time.compare(interval.end, horizon) >= 0)
	);
}

function validateEvidence(
	evidence: Evidence | undefined,
	at: string,
	horizon: string,
	path: string,
	time: TemporalPolicy,
): void {
	if (evidence === undefined) {
		throw new PricingFault(
			"INCOMPLETE_FINANCIAL_STATE",
			`${path} evidence is missing`,
		);
	}
	if (
		compareChecked(evidence.observedAt, `${path}.observedAt`, at, "at", time) >
			0 ||
		compareChecked(evidence.validFrom, `${path}.validFrom`, at, "at", time) >
			0 ||
		compareChecked(
			evidence.validUntil,
			`${path}.validUntil`,
			horizon,
			"horizon",
			time,
		) < 0
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

export function validateScenarioState(
	scenario: QuoteScenario,
	time: TemporalPolicy = EXACT_TIME,
): void {
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
	time.parse(scenario.at, "scenario.at");
	time.parse(scenario.horizon, "scenario.horizon");
	if (time.compare(scenario.horizon, scenario.at) < 0) {
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
	if (
		compareChecked(state.asOf, "state.asOf", scenario.at, "scenario.at", time) >
		0
	) {
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
			compareChecked(
				observation.observedAt,
				`observations.${index}.observedAt`,
				scenario.at,
				"scenario.at",
				time,
			) > 0 ||
			compareChecked(
				observation.validUntil,
				`observations.${index}.validUntil`,
				scenario.horizon,
				"scenario.horizon",
				time,
			) < 0
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
			!intervalCovers(agreement.term, scenario.at, scenario.horizon, time)
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
			time,
		);
	}
	for (const allowance of state.allowances) {
		validateEvidence(
			allowance.grant?.evidence,
			scenario.at,
			scenario.horizon,
			`allowance.${allowance.grant?.id ?? "unknown"}`,
			time,
		);
		if (
			allowance.grant?.effective === undefined ||
			!intervalCovers(
				allowance.grant.effective,
				scenario.at,
				scenario.horizon,
				time,
			)
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
			time,
		);
		if (
			credit.grant?.effective === undefined ||
			!intervalCovers(
				credit.grant.effective,
				scenario.at,
				scenario.horizon,
				time,
			)
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
			time,
		);
		if (
			commitment.commitment?.term === undefined ||
			!intervalCovers(
				commitment.commitment.term,
				scenario.at,
				scenario.horizon,
				time,
			)
		) {
			throw new PricingFault(
				"STALE_OBSERVATION",
				`commitment ${commitment.commitment?.id ?? "unknown"} is not effective`,
			);
		}
	}
}

export function workingState(
	state: FinancialStateView,
	compareStrings: TextComparison = compareCodeUnits,
	compareTimes: TextComparison | null = compareUtcExact,
): FinancialStateView {
	const working = clone(FinancialStateViewSchema, state);
	const compareExpiry = (
		left: string | undefined,
		right: string | undefined,
	): number => {
		if (!compareTimes) return compareStrings(left ?? "9999", right ?? "9999");
		if (left === undefined) return right === undefined ? 0 : 1;
		if (right === undefined) return -1;
		return compareTimes(left, right);
	};
	working.allowances.sort(
		(left, right) =>
			(left.grant?.priority ?? 0) - (right.grant?.priority ?? 0) ||
			compareExpiry(left.grant?.effective?.end, right.grant?.effective?.end) ||
			compareStrings(left.grant?.id ?? "", right.grant?.id ?? ""),
	);
	working.credits.sort(
		(left, right) =>
			(left.grant?.priority ?? 0) - (right.grant?.priority ?? 0) ||
			compareExpiry(left.grant?.effective?.end, right.grant?.effective?.end) ||
			compareStrings(left.grant?.id ?? "", right.grant?.id ?? ""),
	);
	working.commitments.sort((left, right) =>
		compareStrings(left.commitment?.id ?? "", right.commitment?.id ?? ""),
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
