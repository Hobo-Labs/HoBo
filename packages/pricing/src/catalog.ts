import { clone, toJson } from "@bufbuild/protobuf";
import {
	type ChargeComponent,
	type Money,
	type PricingCatalog,
	PricingCatalogSchema,
	type ProviderAgreement,
	type ProviderProduct,
	type RateCard,
	type Tier,
	type WorkloadDelta,
} from "./_generated/pricing_pb.js";
import { compareDecimal, DECIMAL_ZERO, parseDecimal } from "./decimal.js";
import { stableHash } from "./json.js";
import {
	codeUnitPricingOrder,
	legacyPricingOrder,
	type PricingOrder,
} from "./ordering.js";
import { intervalCovers, PricingFault } from "./state.js";
import {
	legacyPricingTimeOrder,
	type PricingTimeOrder,
	utcPricingTimeOrder,
} from "./time-order.js";
import type { PricingRejectionCode } from "./types.js";

function validateTierBoundaries(tiers: readonly Tier[]): void {
	const invalid = () =>
		new PricingFault(
			"INVALID_PRICING_INPUT",
			"tiers must be contiguous, nonnegative and begin at zero",
		);
	const parsed = tiers
		.map((tier) => {
			if (
				tier.from.length > 128 ||
				(tier.to !== undefined && tier.to.length > 128)
			)
				throw invalid();
			const from = parseDecimal(tier.from);
			const to = tier.to === undefined ? undefined : parseDecimal(tier.to);
			if (
				from === undefined ||
				from.coefficient < 0n ||
				(tier.to !== undefined && to === undefined) ||
				(to !== undefined && compareDecimal(to, from) <= 0)
			)
				throw invalid();
			return { from, to };
		})
		.sort((left, right) => compareDecimal(left.from, right.from));
	const first = parsed[0];
	if (first === undefined || compareDecimal(first.from, DECIMAL_ZERO) !== 0)
		throw invalid();
	for (let index = 0; index + 1 < parsed.length; index++) {
		const current = parsed[index];
		const next = parsed[index + 1];
		if (
			current === undefined ||
			next === undefined ||
			compareDecimal(current.from, next.from) >= 0 ||
			(current.to !== undefined && compareDecimal(current.to, next.from) !== 0)
		)
			throw invalid();
	}
}

export function catalogHashOf(catalog: PricingCatalog): string {
	const hashed = clone(PricingCatalogSchema, catalog);
	hashed.catalogHash = "";
	return stableHash(
		toJson(PricingCatalogSchema, hashed, {
			alwaysEmitImplicit: true,
		}),
	);
}

export function resolveProduct(
	catalog: PricingCatalog,
	productRef: string,
): ProviderProduct {
	const matches = catalog.products.filter(
		(product) => product.id === productRef,
	);
	const match = matches[0];
	if (matches.length !== 1 || match === undefined) {
		throw new PricingFault(
			"INVALID_PRICING_INPUT",
			`expected one product named ${productRef}, found ${matches.length}`,
		);
	}
	return match;
}

export function resolveAgreement(
	agreements: readonly ProviderAgreement[],
	agreementRef: string,
): ProviderAgreement {
	const matches = agreements.filter(
		(agreement) => agreement.id === agreementRef,
	);
	const match = matches[0];
	if (matches.length !== 1 || match === undefined) {
		throw new PricingFault(
			"UNKNOWN_AGREEMENT",
			`expected one agreement named ${agreementRef}, found ${matches.length}`,
		);
	}
	return match;
}

export type ResolvedRateCard =
	| { readonly ok: true; readonly card: RateCard }
	| { readonly ok: false; readonly fault: PricingFault };

export function tryResolveRateCard(
	catalog: PricingCatalog,
	agreement: ProviderAgreement,
	at: string,
	horizon: string,
): ResolvedRateCard {
	try {
		return { ok: true, card: resolveRateCard(catalog, agreement, at, horizon) };
	} catch (error) {
		if (error instanceof PricingFault) {
			return { ok: false, fault: error };
		}
		throw error;
	}
}

export function resolveRateCard(
	catalog: PricingCatalog,
	agreement: ProviderAgreement,
	at: string,
	horizon: string,
	order: PricingTimeOrder = legacyPricingTimeOrder,
): RateCard {
	const schedule = agreement.rateSchedule
		.filter(
			(entry) =>
				entry.effective !== undefined &&
				intervalCovers(entry.effective, at, horizon),
		)
		.sort((left, right) =>
			order(right.effective?.start, left.effective?.start),
		);
	const selected = schedule[0];
	if (selected === undefined) {
		throw new PricingFault(
			"RATE_CARD_NOT_FOUND",
			`no effective rate schedule for ${agreement.id}`,
		);
	}
	if (
		order === utcPricingTimeOrder &&
		schedule.some(
			(entry) =>
				entry.rateCardId !== selected.rateCardId &&
				order(entry.effective?.start, selected.effective?.start) === 0,
		)
	)
		throw new PricingFault(
			"PRICING_MODEL_UNSUPPORTED",
			`agreement ${agreement.id} has conflicting rate cards at the same effective instant`,
		);
	const cards = catalog.rateCards.filter(
		(card) =>
			card.id === selected.rateCardId &&
			card.effective !== undefined &&
			intervalCovers(card.effective, at, horizon),
	);
	const card = cards[0];
	if (cards.length !== 1 || card === undefined) {
		throw new PricingFault(
			"RATE_CARD_NOT_FOUND",
			`expected one effective rate card ${selected.rateCardId}, found ${cards.length}`,
		);
	}
	if (order === utcPricingTimeOrder) {
		if (!/^[A-Z]{3}$/u.test(card.currency))
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"rate-card currency is invalid",
			);
		const validAmount = (amount: Money | undefined) => {
			if (
				amount === undefined ||
				amount.currency !== card.currency ||
				amount.decimal.length > 128
			)
				return false;
			const value = parseDecimal(amount.decimal);
			return value !== undefined && value.coefficient >= 0n;
		};
		const identities = new Set<string>();
		const groupKinds = new Map<string, string>();
		if (card.charges.length === 0)
			throw new PricingFault(
				"INVALID_PRICING_INPUT",
				"rate card requires explicit charges",
			);
		for (const charge of card.charges) {
			const id = charge.base?.id;
			if (
				id === undefined ||
				id.length === 0 ||
				id.length > 200 ||
				id.trim() !== id ||
				/[\p{Cc}]/u.test(id) ||
				identities.has(id) ||
				(charge.variant.case !== "fixed" && charge.variant.case !== "usage")
			)
				throw new PricingFault(
					"INVALID_PRICING_INPUT",
					"rate-card charges require unique bounded identities, bases and variants",
				);
			identities.add(id);
			const group = charge.base?.exclusiveGroup;
			if (group === undefined) {
				if (charge.base?.fallback === true)
					throw new PricingFault(
						"INVALID_PRICING_INPUT",
						"a fallback charge requires an exclusive group",
					);
			} else {
				if (
					group.length === 0 ||
					group.length > 200 ||
					group.trim() !== group ||
					/[\p{Cc}]/u.test(group)
				)
					throw new PricingFault(
						"INVALID_PRICING_INPUT",
						"exclusive group identity is invalid",
					);
				const groupKind =
					charge.variant.case === "usage"
						? JSON.stringify(["usage", charge.variant.value.dimension])
						: JSON.stringify(["fixed"]);
				const previous = groupKinds.get(group);
				if (previous !== undefined && previous !== groupKind)
					throw new PricingFault(
						"PRICING_MODEL_UNSUPPORTED",
						"exclusive alternatives across charge types or dimensions are unsupported",
					);
				groupKinds.set(group, groupKind);
			}
			if (charge.variant.case === "fixed") {
				if (!validAmount(charge.variant.value.amount))
					throw new PricingFault(
						"INVALID_PRICING_INPUT",
						"fixed charge requires a nonnegative amount in the rate-card currency",
					);
				continue;
			}
			if (charge.variant.case !== "usage")
				throw new PricingFault(
					"INVALID_PRICING_INPUT",
					"charge variant is invalid",
				);
			const price = charge.variant.value.price;
			const valid =
				price.case === "perUnit"
					? validAmount(price.value)
					: price.case === "package"
						? validAmount(price.value.packageAmount)
						: price.case === "graduated" || price.case === "volume"
							? price.value.tiers.length > 0 &&
								price.value.tiers.every(
									(tier) =>
										validAmount(tier.flatAmount) &&
										validAmount(tier.unitAmount),
								)
							: false;
			if (!valid)
				throw new PricingFault(
					"INVALID_PRICING_INPUT",
					"usage charge requires nonnegative amounts in the rate-card currency",
				);
			if (price.case === "package") {
				const size =
					price.value.packageSize.length <= 128
						? parseDecimal(price.value.packageSize)
						: undefined;
				if (size === undefined || size.coefficient <= 0n)
					throw new PricingFault(
						"INVALID_PRICING_INPUT",
						"package size must be positive",
					);
				const rounding = price.value.rounding;
				const multiple =
					rounding !== undefined && rounding.multiple.length <= 128
						? parseDecimal(rounding.multiple)
						: undefined;
				if (
					rounding === undefined ||
					rounding.scope !== "period" ||
					multiple === undefined ||
					multiple.coefficient !== 1n ||
					multiple.scale !== 0 ||
					!new Set(["ceil", "floor", "half-up"]).has(rounding.mode)
				)
					throw new PricingFault(
						"PRICING_MODEL_UNSUPPORTED",
						"package pricing requires period rounding to whole packages",
					);
			}
			if (price.case === "graduated" || price.case === "volume")
				validateTierBoundaries(price.value.tiers);
		}
	}
	return card;
}

export function chargeSelectorValue(
	workload: WorkloadDelta | undefined,
	key: string,
	dimension: string | undefined,
): string | undefined {
	return key === "productId" || key === "productRef"
		? workload?.productRef
		: key === "agreementId" || key === "agreementRef"
			? workload?.agreementRef
			: key === "dimension"
				? dimension
				: workload?.attributes[key];
}

function matchesSelectors(
	component: ChargeComponent,
	workload: WorkloadDelta | undefined,
	dimension: string | undefined,
	order: PricingOrder,
): boolean {
	const selectors = component.base?.selectors ?? {};
	for (const [key, expected] of Object.entries(selectors).sort(([a], [b]) =>
		order(a, b),
	)) {
		const actual = chargeSelectorValue(workload, key, dimension);
		if (actual !== expected) return false;
	}
	return true;
}

export function selectChargeComponents(
	rateCard: RateCard,
	workload: WorkloadDelta | undefined,
	dimension: string | undefined,
	variant: "fixed" | "usage",
	order: PricingOrder = legacyPricingOrder,
): readonly ChargeComponent[] {
	const relevant = rateCard.charges.filter(
		(component) =>
			component.variant.case === variant &&
			(component.variant.case !== "usage" ||
				(dimension !== undefined &&
					component.variant.value.dimension === dimension)),
	);
	const matching = relevant.filter((component) =>
		matchesSelectors(component, workload, dimension, order),
	);
	if (order === codeUnitPricingOrder) {
		const required = new Set<string>();
		const matched = new Set<string>();
		for (const component of relevant)
			if (component.base?.exclusiveGroup !== undefined)
				required.add(component.base.exclusiveGroup);
		for (const component of matching)
			if (component.base?.exclusiveGroup !== undefined)
				matched.add(component.base.exclusiveGroup);
		for (const group of [...required].sort(order))
			if (!matched.has(group))
				throw new PricingFault(
					"MISSING_EXCLUSIVE_FALLBACK",
					`exclusive group ${group} has no matching charge`,
				);
	}
	const selected: ChargeComponent[] = [];
	const groups = new Map<string, ChargeComponent[]>();
	for (const component of matching) {
		const group = component.base?.exclusiveGroup;
		if (group === undefined) selected.push(component);
		else groups.set(group, [...(groups.get(group) ?? []), component]);
	}
	for (const [group, components] of [...groups.entries()].sort(([a], [b]) =>
		order(a, b),
	)) {
		const nonFallback = components.filter(
			(component) => component.base?.fallback !== true,
		);
		const nonFallbackMatch = nonFallback[0];
		if (nonFallback.length === 1 && nonFallbackMatch !== undefined) {
			selected.push(nonFallbackMatch);
			continue;
		}
		if (nonFallback.length > 1) {
			throw new PricingFault(
				"AMBIGUOUS_EXCLUSIVE_GROUP",
				`exclusive group ${group} has ${nonFallback.length} matching charges`,
			);
		}
		const fallbacks = components.filter(
			(component) => component.base?.fallback === true,
		);
		const fallback = fallbacks[0];
		if (fallbacks.length !== 1 || fallback === undefined) {
			const code: PricingRejectionCode =
				fallbacks.length > 1
					? "AMBIGUOUS_EXCLUSIVE_GROUP"
					: "MISSING_EXCLUSIVE_FALLBACK";
			throw new PricingFault(
				code,
				`exclusive group ${group} has no unambiguous fallback`,
			);
		}
		selected.push(fallback);
	}
	return selected.sort((left, right) =>
		order(left.base?.id ?? "", right.base?.id ?? ""),
	);
}

export function zeroMoney(currency: string) {
	return { decimal: "0", currency };
}
