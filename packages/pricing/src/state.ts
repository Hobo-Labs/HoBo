import { clone, toJson } from "@bufbuild/protobuf";
import {
	type CommitmentAmount,
	type CreditValue,
	type EffectiveInterval,
	type Evidence,
	type FinancialStateView,
	FinancialStateViewSchema,
	type GrantScope,
	type QuoteScenario,
} from "./_generated/pricing_pb.js";
import {
	addDecimal,
	compareDecimal,
	DECIMAL_ZERO,
	type Decimal,
	parseDecimal,
} from "./decimal.js";
import { stableHash } from "./json.js";
import { compareCodeUnits, type TextComparison } from "./order.js";
import type { PricingRejectionCode } from "./types.js";
import { convertQuantity } from "./units.js";

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

function validateFinancialSourceIds(state: FinancialStateView): void {
	if (!state.tenantId)
		throw new PricingFault(
			"INVALID_PRICING_INPUT",
			"financial state tenant is missing",
		);
	const accounts = new Set<string>();
	for (const agreement of state.agreements) {
		if (!agreement.providerAccountRef)
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"agreement provider account is missing",
			);
		accounts.add(agreement.providerAccountRef);
	}
	if (
		accounts.size > 1 &&
		(state.allowances.length > 0 ||
			state.credits.length > 0 ||
			state.commitments.length > 0)
	)
		throw new PricingFault(
			"INVALID_PRICING_INPUT",
			"financial sources cannot be scoped to multiple provider accounts",
		);
	const check = (
		kind: string,
		entries: readonly ({ id: string; tenantId: string } | undefined)[],
	) => {
		const seen = new Set<string>();
		for (const entry of entries) {
			if (!entry?.id || entry.tenantId !== state.tenantId)
				throw new PricingFault(
					"INVALID_PRICING_INPUT",
					`${kind} identity or tenant is invalid`,
				);
			if (seen.has(entry.id))
				throw new PricingFault(
					"INVALID_PRICING_INPUT",
					`duplicate ${kind} identity`,
				);
			seen.add(entry.id);
		}
	};
	check(
		"allowance",
		state.allowances.map((entry) => entry.grant),
	);
	check(
		"credit",
		state.credits.map((entry) => entry.grant),
	);
	check(
		"commitment",
		state.commitments.map((entry) => entry.commitment),
	);
}

function nonnegativeAmount(
	value: { decimal: string } | undefined,
	path: string,
): Decimal {
	const amount = value === undefined ? undefined : parseDecimal(value.decimal);
	if (amount === undefined || compareDecimal(amount, DECIMAL_ZERO) < 0) {
		throw new PricingFault(
			"INVALID_PRICING_INPUT",
			`${path} must be nonnegative`,
		);
	}
	return amount;
}

function nonnegativeSourceValue(
	value: CreditValue | CommitmentAmount | undefined,
	path: string,
): Decimal {
	if (value?.value.case !== "money" && value?.value.case !== "quantity") {
		throw new PricingFault("INVALID_PRICING_INPUT", `${path} is missing`);
	}
	return nonnegativeAmount(value.value.value, path);
}

function sourceUnit(value: CreditValue | CommitmentAmount | undefined): string {
	if (value?.value.case === "money" && value.value.value.currency)
		return `money:${value.value.value.currency}`;
	if (value?.value.case === "quantity" && value.value.value.unit)
		return `quantity:${value.value.value.unit}`;
	throw new PricingFault(
		"INVALID_PRICING_INPUT",
		"financial source unit is missing",
	);
}

function validateFinancialSourceValues(state: FinancialStateView): void {
	for (const allowance of state.allowances) {
		const grant = allowance.grant;
		const included = nonnegativeAmount(grant?.included, "allowance included");
		nonnegativeAmount(allowance.remaining, "allowance remaining");
		nonnegativeAmount(allowance.used, "allowance used");
		const unit = grant?.included?.unit;
		const converted = unit
			? convertQuantity(allowance.remaining, unit)
			: undefined;
		const convertedUsed = unit
			? convertQuantity(allowance.used, unit)
			: undefined;
		if (!unit || !converted || !convertedUsed)
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"allowance units are inconsistent",
			);
		const remaining = nonnegativeAmount(converted, "allowance remaining");
		const used = nonnegativeAmount(convertedUsed, "allowance used");
		const rollover = nonnegativeAmount(
			grant?.rollover === undefined
				? undefined
				: { decimal: grant.rollover.max },
			"allowance rollover",
		);
		if (
			compareDecimal(
				addDecimal(remaining, used),
				addDecimal(included, rollover),
			) > 0
		)
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"allowance used and remaining exceed its declared capacity",
			);
	}
	for (const credit of state.credits) {
		const grant = credit.grant;
		const face = nonnegativeSourceValue(grant?.faceValue, "credit face value");
		const remaining = nonnegativeSourceValue(
			credit.remaining,
			"credit remaining",
		);
		const used = nonnegativeSourceValue(credit.used, "credit used");
		const remainingBasis = nonnegativeAmount(
			credit.remainingBasis,
			"credit remaining basis",
		);
		const usedBasis = nonnegativeAmount(credit.usedBasis, "credit used basis");
		const unit = sourceUnit(grant?.faceValue);
		if (
			sourceUnit(credit.remaining) !== unit ||
			sourceUnit(credit.used) !== unit
		) {
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"credit values use different units",
			);
		}
		if (
			!credit.remainingBasis?.currency ||
			credit.remainingBasis.currency !== credit.usedBasis?.currency ||
			(unit.startsWith("money:") &&
				unit !== `money:${credit.remainingBasis.currency}`)
		) {
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"credit basis currency is inconsistent",
			);
		}
		const rollover = nonnegativeAmount(
			grant?.rollover === undefined
				? undefined
				: { decimal: grant.rollover.max },
			"credit rollover",
		);
		if (
			compareDecimal(addDecimal(remaining, used), addDecimal(face, rollover)) >
			0
		)
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"credit used and remaining exceed its declared capacity",
			);
		const basis = grant?.economicBasis;
		if (basis?.kind === "acquisition") {
			const acquired = nonnegativeAmount(
				basis.acquisitionAmount,
				"credit acquisition basis",
			);
			if (basis.acquisitionAmount?.currency !== credit.remainingBasis.currency)
				throw new PricingFault(
					"INVALID_PRICING_INPUT",
					"credit acquisition currency is inconsistent",
				);
			if (
				grant?.derivedFrom !== undefined &&
				compareDecimal(acquired, DECIMAL_ZERO) !== 0
			) {
				throw new PricingFault(
					"INVALID_PRICING_INPUT",
					"derived credit cannot have acquisition basis",
				);
			}
			if (
				compareDecimal(acquired, DECIMAL_ZERO) > 0 &&
				compareDecimal(rollover, DECIMAL_ZERO) > 0
			)
				throw new PricingFault(
					"PRICING_MODEL_UNSUPPORTED",
					"paid credit rollover has no attributable acquisition basis",
				);
			if (compareDecimal(addDecimal(remainingBasis, usedBasis), acquired) > 0)
				throw new PricingFault(
					"INVALID_PRICING_INPUT",
					"credit recorded basis exceeds its acquisition basis",
				);
		} else if (basis?.kind !== "zero" && basis?.kind !== "face-value") {
			throw new PricingFault(
				"PRICING_MODEL_UNSUPPORTED",
				"credit basis is unsupported",
			);
		} else if (
			basis.kind === "face-value" &&
			grant?.derivedFrom !== undefined
		) {
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"derived credit cannot have face-value basis",
			);
		}
		if (basis.kind === "face-value") {
			if (!unit.startsWith("money:"))
				throw new PricingFault(
					"PRICING_MODEL_UNSUPPORTED",
					"face-value basis requires a monetary credit",
				);
			if (
				compareDecimal(
					addDecimal(remainingBasis, usedBasis),
					addDecimal(face, rollover),
				) > 0
			)
				throw new PricingFault(
					"INVALID_PRICING_INPUT",
					"credit recorded basis exceeds its face value and rollover",
				);
		}
		if (
			(basis.kind === "zero" || grant?.derivedFrom !== undefined) &&
			(compareDecimal(remainingBasis, DECIMAL_ZERO) !== 0 ||
				compareDecimal(usedBasis, DECIMAL_ZERO) !== 0)
		) {
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"zero-basis credit has recorded basis",
			);
		}
	}
	for (const commitment of state.commitments) {
		const declared = nonnegativeSourceValue(
			commitment.commitment?.amount,
			"commitment amount",
		);
		const remaining = nonnegativeSourceValue(
			commitment.remaining,
			"commitment remaining",
		);
		const used = nonnegativeSourceValue(commitment.used, "commitment used");
		const unit = sourceUnit(commitment.commitment?.amount);
		if (
			sourceUnit(commitment.remaining) !== unit ||
			sourceUnit(commitment.used) !== unit
		) {
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"commitment values use different units",
			);
		}
		if (commitment.commitment?.underuse !== "forfeit")
			throw new PricingFault(
				"PRICING_MODEL_UNSUPPORTED",
				"commitment rollover and true-up are unsupported",
			);
		if (compareDecimal(addDecimal(remaining, used), declared) > 0)
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"commitment used and remaining exceed its declared capacity",
			);
	}
}

export function validateScenarioState(
	scenario: QuoteScenario,
	time: TemporalPolicy = EXACT_TIME,
	strictSourceIdentity = true,
	strictSourceValues = true,
	strictCompleteness = true,
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
	if (strictSourceIdentity) validateFinancialSourceIds(state);
	if (strictSourceValues) validateFinancialSourceValues(state);
	if (
		strictCompleteness &&
		state.completeness !== "complete" &&
		state.completeness !== "partial"
	)
		throw new PricingFault(
			"INVALID_PRICING_INPUT",
			"unknown financial state completeness",
		);
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
