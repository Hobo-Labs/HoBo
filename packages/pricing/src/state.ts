import { clone, toJson } from "@bufbuild/protobuf";
import {
	type CommitmentAmount,
	type CreditValue,
	type EffectiveInterval,
	type Evidence,
	type FinancialStateView,
	FinancialStateViewSchema,
	type GrantScope,
	type Money,
	type Quantity,
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
import { codeUnitPricingOrder as order } from "./ordering.js";
import { utcPricingTimeOrder as timeOrder } from "./time-order.js";
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

export function parseUtc(value: string, path: string): number {
	if (!UTC_PATTERN.test(value)) {
		throw new PricingFault(
			"INVALID_PRICING_INPUT",
			`${path} must be an explicit UTC timestamp`,
		);
	}
	const parsed = Date.parse(value);
	if (
		!Number.isFinite(parsed) ||
		new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)
	) {
		throw new PricingFault(
			"INVALID_PRICING_INPUT",
			`${path} is not a valid calendar timestamp`,
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
		) &&
		scenario.action !== "destroy"
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
	if (state.completeness !== "complete" && state.completeness !== "partial")
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
		if (allowance.grant === undefined) {
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"allowance grant is required",
			);
		}
		if (allowance.grant.tenantId !== state.tenantId) {
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"allowance tenant differs from financial state",
			);
		}
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
		if (credit.grant === undefined) {
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"credit grant is required",
			);
		}
		if (credit.grant.tenantId !== state.tenantId) {
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"credit tenant differs from financial state",
			);
		}
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
		if (commitment.commitment === undefined) {
			throw new PricingFault("INVALID_PRICING_INPUT", "commitment is required");
		}
		if (commitment.commitment.tenantId !== state.tenantId) {
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"commitment tenant differs from financial state",
			);
		}
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

export function validateFinancialIdentities(
	state: FinancialStateView | undefined,
): void {
	if (state === undefined)
		throw new PricingFault(
			"INCOMPLETE_FINANCIAL_STATE",
			"financial state is required",
		);
	const ids = [
		...state.allowances.map((item) => item.grant?.id),
		...state.credits.map((item) => item.grant?.id),
		...state.commitments.map((item) => item.commitment?.id),
	];
	const seen = new Set<string>();
	for (const id of ids) {
		if (
			id === undefined ||
			id.length === 0 ||
			id.length > 200 ||
			id.trim() !== id ||
			/[\p{Cc}]/u.test(id) ||
			seen.has(id)
		)
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"allowances, credits and commitments require distinct bounded identities",
			);
		seen.add(id);
	}
}

function validateBalance(
	value: Money | Quantity | undefined,
	path: string,
): void {
	const decimal = value === undefined ? undefined : parseDecimal(value.decimal);
	if (
		value === undefined ||
		decimal === undefined ||
		decimal.coefficient < 0n ||
		("currency" in value
			? !/^[A-Z]{3}$/u.test(value.currency)
			: value.unit.length === 0)
	)
		throw new PricingFault(
			"INVALID_PRICING_INPUT",
			`${path} requires a nonnegative amount with a valid unit`,
		);
}

function validateBalanceValue(
	value:
		| { readonly case: "money"; readonly value: Money }
		| { readonly case: "quantity"; readonly value: Quantity }
		| { readonly case: undefined }
		| undefined,
	path: string,
): void {
	validateBalance(value?.case === undefined ? undefined : value.value, path);
}

export function validateFinancialBalances(state: FinancialStateView): void {
	for (const allowance of state.allowances) {
		validateBalance(allowance.grant?.included, "allowance.included");
		validateBalance(allowance.remaining, "allowance.remaining");
		validateBalance(allowance.used, "allowance.used");
	}
	for (const credit of state.credits) {
		validateBalanceValue(credit.grant?.faceValue?.value, "credit.faceValue");
		validateBalanceValue(credit.remaining?.value, "credit.remaining");
		validateBalanceValue(credit.used?.value, "credit.used");
		validateBalance(credit.remainingBasis, "credit.remainingBasis");
		validateBalance(credit.usedBasis, "credit.usedBasis");
		const basis = credit.grant?.economicBasis;
		if (
			basis === undefined ||
			!["zero", "face-value", "acquisition"].includes(basis.kind) ||
			(basis.kind !== "acquisition" && basis.acquisitionAmount !== undefined)
		)
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"credit economic basis terms are invalid",
			);
		if (basis.kind === "acquisition")
			validateBalance(basis.acquisitionAmount, "credit.acquisitionAmount");
		const face = credit.grant?.faceValue?.value;
		if (face?.case === "money") {
			for (const balance of [credit.remaining?.value, credit.used?.value]) {
				if (balance?.case !== "money")
					throw new PricingFault(
						"PRICING_MODEL_UNSUPPORTED",
						"money credit balances must use money",
					);
				if (balance.value.currency !== face.value.currency)
					throw new PricingFault("CROSS_CURRENCY", "credit currencies differ");
			}
			for (const amount of [
				credit.remainingBasis,
				credit.usedBasis,
				basis?.acquisitionAmount,
			]) {
				if (amount !== undefined && amount.currency !== face.value.currency)
					throw new PricingFault(
						"CROSS_CURRENCY",
						"credit basis currency differs",
					);
			}
		}
		if (
			credit.grant?.derivedFrom !== undefined &&
			(basis?.kind === "face-value" ||
				(basis?.kind === "acquisition" &&
					parseDecimal(basis.acquisitionAmount?.decimal ?? "")?.coefficient !==
						0n))
		)
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"derived credits must have zero economic basis",
			);
		if (
			(basis.kind === "zero" || credit.grant?.derivedFrom !== undefined) &&
			[credit.remainingBasis, credit.usedBasis].some(
				(amount) => parseDecimal(amount?.decimal ?? "")?.coefficient !== 0n,
			)
		)
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"zero-basis credits cannot retain or consume economic basis",
			);
	}
	for (const commitment of state.commitments) {
		validateBalanceValue(
			commitment.commitment?.amount?.value,
			"commitment.amount",
		);
		validateBalanceValue(commitment.remaining?.value, "commitment.remaining");
		validateBalanceValue(commitment.used?.value, "commitment.used");
		const amount = commitment.commitment?.amount?.value;
		const kind = commitment.commitment?.kind;
		if (
			(kind !== "spend" && kind !== "usage") ||
			(kind === "spend" && amount?.case !== "money") ||
			(kind === "usage" && amount?.case !== "quantity")
		)
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"commitment kind and amount do not agree",
			);
		if (amount?.case === "money") {
			for (const balance of [
				commitment.remaining?.value,
				commitment.used?.value,
			]) {
				if (balance?.case !== "money")
					throw new PricingFault(
						"INVALID_PRICING_INPUT",
						"money commitments require money balances",
					);
				if (balance.value.currency !== amount.value.currency)
					throw new PricingFault(
						"CROSS_CURRENCY",
						"commitment currencies differ",
					);
			}
		}
	}
}

function validateGrantScope(scope: GrantScope | undefined): void {
	if (
		scope === undefined ||
		[
			...scope.productIds,
			...scope.rateCardIds,
			...scope.chargeIds,
			...scope.dimensions,
		].some((value) => value.length === 0)
	)
		throw new PricingFault(
			"INVALID_PRICING_INPUT",
			"financial grants require an explicit scope with nonempty identifiers",
		);
}

export function validateGrantScopes(state: FinancialStateView): void {
	for (const allowance of state.allowances)
		validateGrantScope(allowance.grant?.scope);
	for (const credit of state.credits) validateGrantScope(credit.grant?.scope);
	for (const commitment of state.commitments)
		validateGrantScope(commitment.commitment?.scope);
}

export function validateFinancialSourceIds(state: FinancialStateView): void {
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

export function validateFinancialSourceValues(state: FinancialStateView): void {
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

export function workingState(state: FinancialStateView): FinancialStateView {
	const working = clone(FinancialStateViewSchema, state);
	working.allowances.sort(
		(left, right) =>
			(left.grant?.priority ?? 0) - (right.grant?.priority ?? 0) ||
			timeOrder(left.grant?.effective?.end, right.grant?.effective?.end) ||
			order(left.grant?.id ?? "", right.grant?.id ?? ""),
	);
	working.credits.sort(
		(left, right) =>
			(left.grant?.priority ?? 0) - (right.grant?.priority ?? 0) ||
			timeOrder(left.grant?.effective?.end, right.grant?.effective?.end) ||
			order(left.grant?.id ?? "", right.grant?.id ?? ""),
	);
	working.commitments.sort((left, right) =>
		order(left.commitment?.id ?? "", right.commitment?.id ?? ""),
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
