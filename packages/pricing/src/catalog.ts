import { clone, toJson } from "@bufbuild/protobuf";
import {
	type ChargeComponent,
	type PricingCatalog,
	PricingCatalogSchema,
	type ProviderAgreement,
	type ProviderProduct,
	type RateCard,
	type WorkloadDelta,
} from "./_generated/pricing_pb.js";
import { stableHash } from "./json.js";
import { intervalCovers, PricingFault } from "./state.js";
import type { PricingRejectionCode } from "./types.js";

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

export function resolveRateCard(
	catalog: PricingCatalog,
	agreement: ProviderAgreement,
	at: string,
	horizon: string,
): RateCard {
	const schedule = agreement.rateSchedule
		.filter(
			(entry) =>
				entry.effective !== undefined &&
				intervalCovers(entry.effective, at, horizon),
		)
		.sort(
			(left, right) =>
				right.effective?.start.localeCompare(left.effective?.start ?? "") ?? 0,
		);
	const selected = schedule[0];
	if (selected === undefined) {
		throw new PricingFault(
			"RATE_CARD_NOT_FOUND",
			`no effective rate schedule for ${agreement.id}`,
		);
	}
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
	return card;
}

function matchesSelectors(
	component: ChargeComponent,
	workload: WorkloadDelta | undefined,
	dimension: string | undefined,
): boolean {
	const selectors = component.base?.selectors ?? {};
	for (const [key, expected] of Object.entries(selectors).sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		const actual =
			key === "productId" || key === "productRef"
				? workload?.productRef
				: key === "agreementId" || key === "agreementRef"
					? workload?.agreementRef
					: key === "dimension"
						? dimension
						: workload?.attributes[key];
		if (actual !== expected) return false;
	}
	return true;
}

export function selectChargeComponents(
	rateCard: RateCard,
	workload: WorkloadDelta | undefined,
	dimension: string | undefined,
	variant: "fixed" | "usage",
): readonly ChargeComponent[] {
	const matching = rateCard.charges.filter(
		(component) =>
			component.variant.case === variant &&
			(component.variant.case !== "usage" ||
				(dimension !== undefined &&
					component.variant.value.dimension === dimension)) &&
			matchesSelectors(component, workload, dimension),
	);
	const selected: ChargeComponent[] = [];
	const groups = new Map<string, ChargeComponent[]>();
	for (const component of matching) {
		const group = component.base?.exclusiveGroup;
		if (group === undefined) selected.push(component);
		else groups.set(group, [...(groups.get(group) ?? []), component]);
	}
	for (const [group, components] of [...groups.entries()].sort(([a], [b]) =>
		a.localeCompare(b),
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
		(left.base?.id ?? "").localeCompare(right.base?.id ?? ""),
	);
}

export function zeroMoney(currency: string) {
	return { decimal: "0", currency };
}
