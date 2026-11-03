import { create } from "@bufbuild/protobuf";
import {
	type CommitmentAmount,
	CommitmentAmountSchema,
	type Consumption,
	ConsumptionSchema,
	type CreditValue,
	CreditValueSchema,
	type FinancialStateView,
	type MeterDefinition,
	type Money,
	MoneySchema,
	type NewObligation,
	type ProjectedWaste,
	ProjectedWasteSchema,
	type ProviderAgreement,
	type Quantity,
	QuantitySchema,
	type QuoteLine,
	QuoteLineSchema,
	type QuoteScenario,
	type RateCard,
	type RemainingHeadroom,
	RemainingHeadroomSchema,
	type Rounding,
	type TieredPrice,
	type UsageMeasurement,
	type WorkloadDelta,
} from "./_generated/pricing_pb.js";
import {
	resolveAgreement,
	resolveProduct,
	resolveRateCard,
	selectChargeComponents,
} from "./catalog.js";
import {
	addDecimal,
	compareDecimal,
	DECIMAL_ZERO,
	type Decimal,
	decimalFromBigInt,
	divideDecimal,
	formatDecimal,
	maxDecimal,
	minDecimal,
	multiplyDecimal,
	parseDecimal,
	roundDecimalToMultiple,
	subtractDecimal,
} from "./decimal.js";
import { PricingFault, scopeMatches, workingState } from "./state.js";
import { convertQuantity } from "./units.js";

export type RatedSnapshot = {
	readonly currency: string;
	readonly billed: Money;
	readonly effective: Money;
	readonly dueNow: Money;
	readonly nominalAtListRate: Money;
	readonly lines: readonly QuoteLine[];
	readonly consumption: readonly Consumption[];
	readonly remainingHeadroom: readonly RemainingHeadroom[];
	readonly projectedWaste: readonly ProjectedWaste[];
	readonly newObligations: readonly NewObligation[];
};

type MutableLine = {
	chargeId: string;
	agreementRef: string;
	productRef: string;
	rateCardId: string;
	dimension: string;
	quantity: Quantity;
	unitPrice: Money;
	billed: Decimal;
	effective: Decimal;
	dueNow: Decimal;
	category: string;
	grantIds: string[];
	commitmentIds: string[];
};

function requiredDecimal(value: string, path: string): Decimal {
	const parsed = parseDecimal(value);
	if (parsed === undefined) {
		throw new PricingFault(
			"INVALID_PRICING_INPUT",
			`${path} is not an exact decimal string`,
		);
	}
	return parsed;
}

function moneyDecimal(money: Money | undefined, path: string): Decimal {
	if (money === undefined) {
		throw new PricingFault("INVALID_PRICING_INPUT", `${path} is missing`);
	}
	return requiredDecimal(money.decimal, path);
}

function requireCurrency(
	money: Money | undefined,
	currency: string,
	path: string,
): Money {
	if (money === undefined || money.currency !== currency) {
		throw new PricingFault("CROSS_CURRENCY", `${path} must use ${currency}`);
	}
	return money;
}

function moneyOf(value: Decimal, currency: string): Money {
	return create(MoneySchema, { decimal: formatDecimal(value), currency });
}

function quantityOf(value: Decimal, unit: string): Quantity {
	return create(QuantitySchema, { decimal: formatDecimal(value), unit });
}

function quantityDecimal(
	quantity: Quantity | undefined,
	path: string,
): Decimal {
	if (quantity === undefined) {
		throw new PricingFault("INVALID_PRICING_INPUT", `${path} is missing`);
	}
	const value = requiredDecimal(quantity.decimal, path);
	if (compareDecimal(value, DECIMAL_ZERO) < 0) {
		throw new PricingFault(
			"INVALID_PRICING_INPUT",
			`${path} cannot be negative`,
		);
	}
	return value;
}

function creditMoney(value: CreditValue | undefined, path: string): Money {
	if (value?.value.case !== "money") {
		throw new PricingFault(
			"PRICING_MODEL_UNSUPPORTED",
			`${path} must be money for spend rating`,
		);
	}
	return value.value.value;
}

function commitmentMoney(
	value: CommitmentAmount | undefined,
	path: string,
): Money {
	if (value?.value.case !== "money") {
		throw new PricingFault(
			"PRICING_MODEL_UNSUPPORTED",
			`${path} must be money for spend rating`,
		);
	}
	return value.value.value;
}

function roundQuantity(
	quantity: Quantity,
	rounding: Rounding | undefined,
): Quantity {
	if (rounding === undefined) return quantity;
	const value = quantityDecimal(quantity, "rounding quantity");
	const multiple = requiredDecimal(rounding.multiple, "rounding.multiple");
	if (
		(rounding.mode !== "ceil" &&
			rounding.mode !== "floor" &&
			rounding.mode !== "half-up") ||
		!new Set(["event", "period"]).has(rounding.scope)
	) {
		throw new PricingFault(
			"PRICING_MODEL_UNSUPPORTED",
			"unknown rounding rule",
		);
	}
	const rounded = roundDecimalToMultiple(value, multiple, rounding.mode);
	if (rounded === undefined) {
		throw new PricingFault(
			"INVALID_PRICING_INPUT",
			"rounding multiple must be positive",
		);
	}
	return quantityOf(rounded, quantity.unit);
}

function aggregateMeasurements(
	meter: MeterDefinition,
	entries: readonly { delta: WorkloadDelta; measurement: UsageMeasurement }[],
): Quantity {
	if (meter.aggregation === "unique-count") {
		const values = new Set<string>();
		for (const entry of entries) {
			for (const value of entry.measurement.uniqueValues) {
				if (entry.delta.direction === "add") values.add(value);
				else if (entry.delta.direction === "remove") values.delete(value);
				else
					throw new PricingFault(
						"INVALID_PRICING_INPUT",
						"unknown workload direction",
					);
			}
		}
		return quantityOf(decimalFromBigInt(BigInt(values.size)), meter.unit);
	}
	if (
		meter.aggregation !== "sum" &&
		entries.some((entry) => entry.delta.direction === "remove")
	) {
		throw new PricingFault(
			"PRICING_MODEL_UNSUPPORTED",
			`${meter.aggregation} meters do not support removal`,
		);
	}
	const roundedEntries = entries.map((entry) => {
		if (entry.measurement.dimension !== meter.dimension) {
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"measurement dimension mismatch",
			);
		}
		const converted = convertQuantity(entry.measurement.quantity, meter.unit);
		if (converted === undefined) {
			throw new PricingFault(
				"UNIT_CONVERSION_UNSUPPORTED",
				`cannot convert measurement to ${meter.unit}`,
			);
		}
		return {
			entry,
			quantity:
				meter.rounding?.scope === "event"
					? roundQuantity(converted, meter.rounding)
					: converted,
		};
	});
	let aggregate: Quantity;
	if (meter.aggregation === "latest") {
		const latest = [...roundedEntries].sort((left, right) =>
			right.entry.measurement.observedAt.localeCompare(
				left.entry.measurement.observedAt,
			),
		)[0];
		aggregate = latest?.quantity ?? quantityOf(DECIMAL_ZERO, meter.unit);
	} else if (meter.aggregation === "max") {
		aggregate =
			roundedEntries.reduce<Quantity | undefined>(
				(current, entry) =>
					current === undefined ||
					compareDecimal(
						quantityDecimal(entry.quantity, "max quantity"),
						quantityDecimal(current, "max quantity"),
					) > 0
						? entry.quantity
						: current,
				undefined,
			) ?? quantityOf(DECIMAL_ZERO, meter.unit);
	} else if (meter.aggregation === "sum") {
		let total = DECIMAL_ZERO;
		for (const { entry, quantity } of roundedEntries) {
			const value = quantityDecimal(quantity, "sum quantity");
			total =
				entry.delta.direction === "add"
					? addDecimal(total, value)
					: entry.delta.direction === "remove"
						? subtractDecimal(total, value)
						: (() => {
								throw new PricingFault(
									"INVALID_PRICING_INPUT",
									"unknown workload direction",
								);
							})();
		}
		if (compareDecimal(total, DECIMAL_ZERO) < 0) {
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"workload quantity is negative",
			);
		}
		aggregate = quantityOf(total, meter.unit);
	} else {
		throw new PricingFault(
			"PRICING_MODEL_UNSUPPORTED",
			`unknown aggregation ${meter.aggregation}`,
		);
	}
	return meter.rounding?.scope === "period"
		? roundQuantity(aggregate, meter.rounding)
		: aggregate;
}

function consumeAllowances(
	state: FinancialStateView,
	agreement: ProviderAgreement,
	rateCard: RateCard,
	chargeId: string,
	dimension: string,
	quantity: Quantity,
	consumption: Consumption[],
) {
	let remaining = quantityDecimal(quantity, "charge quantity");
	const grantIds: string[] = [];
	let blockUsage = false;
	for (const allowance of state.allowances) {
		const grant = allowance.grant;
		if (
			grant === undefined ||
			!scopeMatches(
				grant.scope,
				agreement.productId,
				rateCard.id,
				chargeId,
				dimension,
			)
		) {
			continue;
		}
		blockUsage ||= grant.exhaustion === "block-usage";
		const converted = convertQuantity(allowance.remaining, quantity.unit);
		if (converted === undefined) {
			throw new PricingFault(
				"UNIT_CONVERSION_UNSUPPORTED",
				`allowance ${grant.id} unit mismatch`,
			);
		}
		const available = quantityDecimal(
			converted,
			`allowance.${grant.id}.remaining`,
		);
		const consumed = minDecimal(remaining, available);
		if (compareDecimal(consumed, DECIMAL_ZERO) === 0) continue;
		remaining = subtractDecimal(remaining, consumed);
		allowance.remaining = quantityOf(
			subtractDecimal(available, consumed),
			quantity.unit,
		);
		grantIds.push(grant.id);
		consumption.push(
			create(ConsumptionSchema, {
				sourceId: grant.id,
				kind: "allowance",
				dimension,
				quantity: quantityOf(consumed, quantity.unit),
			}),
		);
		if (compareDecimal(remaining, DECIMAL_ZERO) === 0) break;
	}
	if (blockUsage && compareDecimal(remaining, DECIMAL_ZERO) > 0) {
		throw new PricingFault(
			"USAGE_LIMIT_EXCEEDED",
			"hard allowance is exhausted",
		);
	}
	return { quantity: quantityOf(remaining, quantity.unit), grantIds };
}

function unitPriceOf(
	charge: RateCard["charges"][number],
	currency: string,
): Money {
	if (charge.variant.case === "fixed") {
		return requireCurrency(
			charge.variant.value.amount,
			currency,
			"fixed amount",
		);
	}
	if (
		charge.variant.case === "usage" &&
		charge.variant.value.price.case === "perUnit"
	) {
		return charge.variant.value.price.value;
	}
	return create(MoneySchema, { decimal: "0", currency });
}

function priceUsage(
	charge: RateCard["charges"][number],
	quantity: Quantity,
	currency: string,
): Decimal {
	if (charge.variant.case !== "usage") {
		throw new PricingFault(
			"INVALID_PRICING_INPUT",
			"usage price requires a usage charge",
		);
	}
	const value = quantityDecimal(quantity, "priced quantity");
	const price = charge.variant.value.price;
	if (price.case === "perUnit") {
		requireCurrency(price.value, currency, "per-unit price");
		return multiplyDecimal(value, moneyDecimal(price.value, "per-unit price"));
	}
	if (price.case === "package") {
		const packagePrice = price.value;
		requireCurrency(packagePrice.packageAmount, currency, "package amount");
		const size = requiredDecimal(packagePrice.packageSize, "package size");
		const rounded = roundDecimalToMultiple(
			value,
			size,
			packagePrice.rounding?.mode === "floor" ||
				packagePrice.rounding?.mode === "half-up"
				? packagePrice.rounding.mode
				: "ceil",
		);
		if (rounded === undefined || compareDecimal(size, DECIMAL_ZERO) <= 0) {
			throw new PricingFault("INVALID_PRICING_INPUT", "invalid package size");
		}
		const packages = divideDecimal(rounded, size);
		if (packages === undefined)
			throw new PricingFault("INVALID_PRICING_INPUT", "invalid package size");
		return multiplyDecimal(
			packages,
			moneyDecimal(packagePrice.packageAmount, "package amount"),
		);
	}
	if (price.case === "graduated" || price.case === "volume") {
		return priceTiers(price.value, value, currency, price.case);
	}
	throw new PricingFault(
		"PRICING_MODEL_UNSUPPORTED",
		"usage charge has no supported price",
	);
}

function priceTiers(
	tiered: TieredPrice,
	quantity: Decimal,
	currency: string,
	mode: "graduated" | "volume",
): Decimal {
	const tiers = [...tiered.tiers].sort((left, right) =>
		compareDecimal(
			requiredDecimal(left.from, "tier.from"),
			requiredDecimal(right.from, "tier.from"),
		),
	);
	if (tiers.length === 0)
		throw new PricingFault("INVALID_PRICING_INPUT", "tier list is empty");
	let total = DECIMAL_ZERO;
	for (const [index, tier] of tiers.entries()) {
		const from = requiredDecimal(tier.from, "tier.from");
		const next = tiers[index + 1];
		const to =
			tier.to === undefined
				? next === undefined
					? undefined
					: requiredDecimal(next.from, "tier.from")
				: requiredDecimal(tier.to, "tier.to");
		requireCurrency(tier.flatAmount, currency, "tier flat amount");
		requireCurrency(tier.unitAmount, currency, "tier unit amount");
		if (mode === "volume") {
			if (
				compareDecimal(quantity, from) >= 0 &&
				(to === undefined || compareDecimal(quantity, to) < 0)
			) {
				return addDecimal(
					moneyDecimal(tier.flatAmount, "tier flat amount"),
					multiplyDecimal(
						quantity,
						moneyDecimal(tier.unitAmount, "tier unit amount"),
					),
				);
			}
			continue;
		}
		const upper = to === undefined ? quantity : minDecimal(quantity, to);
		const covered = maxDecimal(subtractDecimal(upper, from), DECIMAL_ZERO);
		if (compareDecimal(covered, DECIMAL_ZERO) > 0) {
			total = addDecimal(
				total,
				moneyDecimal(tier.flatAmount, "tier flat amount"),
			);
			total = addDecimal(
				total,
				multiplyDecimal(
					covered,
					moneyDecimal(tier.unitAmount, "tier unit amount"),
				),
			);
		}
	}
	if (mode === "volume")
		throw new PricingFault(
			"RATE_CARD_NOT_FOUND",
			"quantity is outside volume tiers",
		);
	return total;
}

function applyCommitments(
	state: FinancialStateView,
	agreement: ProviderAgreement,
	rateCard: RateCard,
	lines: MutableLine[],
	consumption: Consumption[],
	scenario: QuoteScenario,
): void {
	for (const line of lines) {
		for (const commitmentState of state.commitments) {
			const commitment = commitmentState.commitment;
			if (
				commitment === undefined ||
				!scopeMatches(
					commitment.scope,
					agreement.productId,
					rateCard.id,
					line.chargeId,
					line.dimension,
				)
			) {
				continue;
			}
			if (
				commitment.kind !== "spend" ||
				commitment.amortization !== "provider-actual" ||
				commitment.payment !== "upfront" ||
				commitment.bucketGranularity !== "billing-period" ||
				scenario.options?.amortization !== "provider-actual"
			) {
				throw new PricingFault(
					"PRICING_MODEL_UNSUPPORTED",
					`commitment ${commitment.id} terms are unsupported`,
				);
			}
			const remainingMoney = commitmentMoney(
				commitmentState.remaining,
				"commitment remaining",
			);
			requireCurrency(
				remainingMoney,
				rateCard.currency,
				"commitment remaining",
			);
			const available = moneyDecimal(remainingMoney, "commitment remaining");
			const consumed = minDecimal(line.billed, available);
			if (compareDecimal(consumed, DECIMAL_ZERO) === 0) continue;
			line.billed = subtractDecimal(line.billed, consumed);
			line.dueNow = maxDecimal(
				subtractDecimal(line.dueNow, consumed),
				DECIMAL_ZERO,
			);
			commitmentState.remaining = create(CommitmentAmountSchema, {
				value: {
					case: "money",
					value: moneyOf(
						subtractDecimal(available, consumed),
						rateCard.currency,
					),
				},
			});
			line.commitmentIds.push(commitment.id);
			consumption.push(
				create(ConsumptionSchema, {
					sourceId: commitment.id,
					kind: "commitment",
					dimension: line.dimension,
					quantity: quantityOf(consumed, rateCard.currency),
				}),
			);
		}
	}
}

function applyCredits(
	state: FinancialStateView,
	agreement: ProviderAgreement,
	rateCard: RateCard,
	lines: MutableLine[],
	consumption: Consumption[],
): void {
	for (const line of lines) {
		for (const creditState of state.credits) {
			const grant = creditState.grant;
			if (
				grant === undefined ||
				!scopeMatches(
					grant.scope,
					agreement.productId,
					rateCard.id,
					line.chargeId,
					line.dimension,
				)
			)
				continue;
			if (
				grant.derivedFrom !== undefined &&
				grant.economicBasis?.kind === "face-value"
			) {
				throw new PricingFault(
					"INVALID_PRICING_INPUT",
					`derived credit ${grant.id} has nonzero basis`,
				);
			}
			const remainingMoney = creditMoney(
				creditState.remaining,
				"credit remaining",
			);
			requireCurrency(remainingMoney, rateCard.currency, "credit remaining");
			const face = creditMoney(grant.faceValue, "credit face value");
			requireCurrency(face, rateCard.currency, "credit face value");
			const faceTotal = moneyDecimal(face, "credit face value");
			const available = moneyDecimal(remainingMoney, "credit remaining");
			const consumed = minDecimal(line.billed, available);
			if (compareDecimal(consumed, DECIMAL_ZERO) === 0) continue;
			let basis = DECIMAL_ZERO;
			if (grant.economicBasis?.kind === "face-value") basis = consumed;
			if (grant.economicBasis?.kind === "acquisition") {
				const acquisition = grant.economicBasis.acquisitionAmount;
				requireCurrency(acquisition, rateCard.currency, "credit acquisition");
				const ratio = divideDecimal(
					moneyDecimal(acquisition, "credit acquisition"),
					faceTotal,
				);
				if (ratio === undefined)
					throw new PricingFault(
						"INVALID_PRICING_INPUT",
						"credit face value is zero",
					);
				basis = multiplyDecimal(consumed, ratio);
			}
			if (
				grant.economicBasis?.kind !== "zero" &&
				grant.economicBasis?.kind !== "face-value" &&
				grant.economicBasis?.kind !== "acquisition"
			) {
				throw new PricingFault(
					"PRICING_MODEL_UNSUPPORTED",
					`credit ${grant.id} basis is unsupported`,
				);
			}
			line.billed = subtractDecimal(line.billed, consumed);
			line.dueNow = maxDecimal(
				subtractDecimal(line.dueNow, consumed),
				DECIMAL_ZERO,
			);
			line.effective = addDecimal(
				subtractDecimal(line.effective, consumed),
				basis,
			);
			creditState.remaining = create(CreditValueSchema, {
				value: {
					case: "money",
					value: moneyOf(
						subtractDecimal(available, consumed),
						rateCard.currency,
					),
				},
			});
			creditState.remainingBasis = moneyOf(
				maxDecimal(
					subtractDecimal(
						moneyDecimal(creditState.remainingBasis, "remaining basis"),
						basis,
					),
					DECIMAL_ZERO,
				),
				rateCard.currency,
			);
			line.grantIds.push(grant.id);
			consumption.push(
				create(ConsumptionSchema, {
					sourceId: grant.id,
					kind: "credit",
					dimension: line.dimension,
					quantity: quantityOf(consumed, rateCard.currency),
				}),
			);
		}
	}
}

function fixedQuantity(
	fixed: RateCard["charges"][number],
	workloads: readonly WorkloadDelta[],
	agreement: ProviderAgreement,
): Quantity {
	if (fixed.variant.case !== "fixed")
		return quantityOf(decimalFromBigInt(1n), "agreement");
	const dimension = fixed.variant.value.quantityDimension;
	if (dimension === undefined)
		return quantityOf(decimalFromBigInt(1n), "agreement");
	let total = requiredDecimal(
		agreement.quantities[dimension] ?? "0",
		`agreement quantity ${dimension}`,
	);
	for (const workload of workloads) {
		const delta = requiredDecimal(
			workload.quantities[dimension] ?? "0",
			`workload quantity ${dimension}`,
		);
		total =
			workload.direction === "add"
				? addDecimal(total, delta)
				: workload.direction === "remove"
					? subtractDecimal(total, delta)
					: (() => {
							throw new PricingFault(
								"INVALID_PRICING_INPUT",
								"unknown workload direction",
							);
						})();
	}
	if (compareDecimal(total, DECIMAL_ZERO) < 0)
		throw new PricingFault(
			"INVALID_PRICING_INPUT",
			"fixed quantity is negative",
		);
	return quantityOf(total, dimension);
}

function finalizeLine(line: MutableLine, currency: string): QuoteLine {
	return create(QuoteLineSchema, {
		chargeId: line.chargeId,
		agreementRef: line.agreementRef,
		productRef: line.productRef,
		description: line.dimension,
		quantity: line.quantity,
		unitPrice: line.unitPrice,
		billed: moneyOf(line.billed, currency),
		effective: moneyOf(line.effective, currency),
		dueNow: moneyOf(line.dueNow, currency),
		category: line.category,
		grantIds: [...new Set(line.grantIds)].sort(),
		commitmentIds: [...new Set(line.commitmentIds)].sort(),
	});
}

export function rateSnapshot(
	scenario: QuoteScenario,
	workloads: readonly WorkloadDelta[],
): RatedSnapshot {
	const stateView = scenario.state;
	const catalog = scenario.catalog;
	if (stateView === undefined || catalog === undefined) {
		throw new PricingFault(
			"INCOMPLETE_FINANCIAL_STATE",
			"state and catalog are required",
		);
	}
	const state = workingState(stateView);
	const lines: MutableLine[] = [];
	const consumption: Consumption[] = [];
	let nominal = DECIMAL_ZERO;
	let currency = "";
	const agreementIds = new Set([
		...state.agreements
			.filter((agreement) => agreement.status === "active")
			.map((agreement) => agreement.id),
		...workloads.map((workload) => workload.agreementRef),
	]);
	for (const agreementRef of [...agreementIds].sort()) {
		const agreement = resolveAgreement(state.agreements, agreementRef);
		const product = resolveProduct(catalog, agreement.productId);
		const rateCard = resolveRateCard(
			catalog,
			agreement,
			scenario.at,
			scenario.horizon,
		);
		if (currency === "") currency = rateCard.currency;
		if (currency !== rateCard.currency)
			throw new PricingFault(
				"CROSS_CURRENCY",
				"all charges must share one currency",
			);
		const agreementWorkloads = workloads.filter(
			(workload) => workload.agreementRef === agreementRef,
		);
		const workload = agreementWorkloads[0];
		for (const charge of selectChargeComponents(
			rateCard,
			workload,
			undefined,
			"fixed",
		)) {
			if (charge.variant.case !== "fixed" || charge.base === undefined)
				continue;
			if (charge.variant.value.proration !== "none")
				throw new PricingFault(
					"PRICING_MODEL_UNSUPPORTED",
					"proration is not supported in batch 1",
				);
			const quantity = fixedQuantity(charge, agreementWorkloads, agreement);
			const amount = charge.variant.value.amount;
			requireCurrency(amount, currency, "fixed amount");
			const unit = moneyDecimal(amount, "fixed amount");
			const billed = multiplyDecimal(
				quantityDecimal(quantity, "fixed quantity"),
				unit,
			);
			nominal = addDecimal(nominal, billed);
			lines.push({
				chargeId: charge.base.id,
				agreementRef,
				productRef: agreement.productId,
				rateCardId: rateCard.id,
				dimension: charge.variant.value.quantityDimension ?? "agreement",
				quantity,
				unitPrice: unitPriceOf(charge, currency),
				billed,
				effective: billed,
				dueNow:
					charge.variant.value.timing === "advance" ? billed : DECIMAL_ZERO,
				category: "purchase",
				grantIds: [],
				commitmentIds: [],
			});
		}
		for (const meter of [...product.meters].sort((left, right) =>
			left.dimension.localeCompare(right.dimension),
		)) {
			const entries = agreementWorkloads.flatMap((delta) =>
				delta.usage
					.filter((measurement) => measurement.dimension === meter.dimension)
					.map((measurement) => ({ delta, measurement })),
			);
			const charges = selectChargeComponents(
				rateCard,
				workload,
				meter.dimension,
				"usage",
			);
			if (entries.length === 0 && charges.length > 0) continue;
			if (charges.length === 0 && entries.length > 0) {
				throw new PricingFault(
					"RATE_CARD_NOT_FOUND",
					`no charge for ${meter.dimension}`,
				);
			}
			const measured = aggregateMeasurements(meter, entries);
			for (const charge of charges) {
				if (charge.variant.case !== "usage" || charge.base === undefined)
					continue;
				const allowance = consumeAllowances(
					state,
					agreement,
					rateCard,
					charge.base.id,
					meter.dimension,
					measured,
					consumption,
				);
				const billed = priceUsage(charge, allowance.quantity, currency);
				nominal = addDecimal(nominal, priceUsage(charge, measured, currency));
				lines.push({
					chargeId: charge.base.id,
					agreementRef,
					productRef: agreement.productId,
					rateCardId: rateCard.id,
					dimension: meter.dimension,
					quantity: allowance.quantity,
					unitPrice: unitPriceOf(charge, currency),
					billed,
					effective: billed,
					dueNow:
						charge.variant.value.timing === "advance" ? billed : DECIMAL_ZERO,
					category: "usage",
					grantIds: allowance.grantIds,
					commitmentIds: [],
				});
			}
		}
		const agreementLines = lines.filter(
			(line) => line.agreementRef === agreementRef,
		);
		applyCommitments(
			state,
			agreement,
			rateCard,
			agreementLines,
			consumption,
			scenario,
		);
		applyCredits(state, agreement, rateCard, agreementLines, consumption);
	}
	const finalized = lines.map((line) => finalizeLine(line, currency));
	const total = (select: (line: MutableLine) => Decimal) =>
		lines.reduce((sum, line) => addDecimal(sum, select(line)), DECIMAL_ZERO);
	const remainingHeadroom: RemainingHeadroom[] = [
		...state.allowances.map((allowance) => {
			if (allowance.remaining === undefined) {
				throw new PricingFault(
					"INCOMPLETE_FINANCIAL_STATE",
					"allowance remaining is missing",
				);
			}
			return create(RemainingHeadroomSchema, {
				sourceId: allowance.grant?.id ?? "",
				dimension:
					allowance.grant?.scope?.dimensions[0] ?? allowance.remaining.unit,
				quantity: allowance.remaining,
			});
		}),
		...state.credits.map((credit) =>
			create(RemainingHeadroomSchema, {
				sourceId: credit.grant?.id ?? "",
				dimension: "credit",
				quantity: quantityOf(
					moneyDecimal(
						creditMoney(credit.remaining, "remaining credit"),
						"remaining credit",
					),
					currency,
				),
			}),
		),
		...state.commitments.map((commitment) =>
			create(RemainingHeadroomSchema, {
				sourceId: commitment.commitment?.id ?? "",
				dimension: "commitment",
				quantity: quantityOf(
					moneyDecimal(
						commitmentMoney(commitment.remaining, "remaining commitment"),
						"remaining commitment",
					),
					currency,
				),
			}),
		),
	].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
	const projectedWaste: ProjectedWaste[] = state.commitments.map((commitment) =>
		create(ProjectedWasteSchema, {
			commitmentId: commitment.commitment?.id ?? "",
			bucketStart: scenario.at,
			bucketEnd: scenario.horizon,
			amount: commitment.remaining,
		}),
	);
	return {
		currency,
		billed: moneyOf(
			total((line) => line.billed),
			currency,
		),
		effective: moneyOf(
			total((line) => line.effective),
			currency,
		),
		dueNow: moneyOf(
			total((line) => line.dueNow),
			currency,
		),
		nominalAtListRate: moneyOf(nominal, currency),
		lines: finalized,
		consumption,
		remainingHeadroom,
		projectedWaste,
		newObligations: [],
	};
}
