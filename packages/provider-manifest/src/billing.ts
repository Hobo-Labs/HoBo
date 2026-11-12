/**
 * Billing section -> `@hobo/pricing` `PricingCatalog`.
 *
 * The manifest is the authoring surface; the rating kernel's types are the
 * runtime ones. Nothing here invents a pricing model: a charge either maps
 * onto a model the kernel executes, or its whole plan is reported as unrated.
 */
import { create } from "@bufbuild/protobuf";
import {
	catalogHashOf,
	EffectiveIntervalSchema,
	FixedChargeSchema,
	formatDecimal,
	type PricingCatalog,
	PricingCatalogSchema,
	parseDecimal,
	TierSchema,
} from "@hobo/pricing";
import type {
	BillableDefinition,
	BillingPlan,
	BillingProduct,
	Charge,
	MeteredCharge,
	TierList,
} from "./_generated/provider_manifest_pb.js";
import { type ParsedProviderManifest, perUnitPrice } from "./parse.js";

/** A plan the kernel cannot rate. It gets no rate card rather than a low one. */
export type UnratedPlan = {
	readonly productId: string;
	readonly planId: string;
	readonly chargeId: string;
	readonly model: string;
	readonly reason: string;
};

export type RatedPlan = {
	readonly productId: string;
	readonly planId: string;
	/** Product id as it appears in the pricing catalog. */
	readonly productRef: string;
	readonly rateCardId: string;
};

/**
 * Included usage as the provider declares it. A fact about the plan, not a
 * tenant grant: an `AllowanceGrant` needs a tenant and dated evidence, which
 * a public manifest cannot supply.
 */
export type DeclaredIncludedUsage = {
	readonly productId: string;
	readonly planId: string;
	readonly billable: string;
	readonly quantity: string;
	readonly unit: string;
	readonly reset: string;
};

export type BillingLowering = {
	readonly catalog: PricingCatalog;
	readonly rated: readonly RatedPlan[];
	readonly unrated: readonly UnratedPlan[];
	readonly included: readonly DeclaredIncludedUsage[];
};

/** The pricing-catalog product id for a manifest product. */
export function pricingProductRef(
	providerId: string,
	productId: string,
): string {
	return `${providerId}/${productId}`;
}

function tiers(list: TierList, currency: string) {
	let from = "0";
	return list.tiers.map((tier) => {
		const lowered = create(TierSchema, {
			from,
			flatAmount: {
				decimal: tier.flatFee === "" ? "0" : tier.flatFee,
				currency,
			},
			unitAmount: { decimal: tier.unitPrice, currency },
		});
		if (tier.upTo !== undefined) {
			lowered.to = tier.upTo;
			from = tier.upTo;
		}
		return lowered;
	});
}

function usagePrice(metered: MeteredCharge, currency: string) {
	const rate = metered.rate;
	switch (rate.case) {
		case "unitPrice":
			return {
				case: "perUnit" as const,
				value: { decimal: rate.value, currency },
			};
		case "package": {
			if (rate.value.whole) {
				return {
					case: "package" as const,
					value: {
						packageSize: rate.value.per,
						packageAmount: { decimal: rate.value.amount, currency },
						rounding: { scope: "period", multiple: "1", mode: "ceil" },
					},
				};
			}
			const amount = parseDecimal(rate.value.amount);
			const per = parseDecimal(rate.value.per);
			const unit =
				amount === undefined || per === undefined
					? undefined
					: perUnitPrice(amount, per);
			if (unit === undefined) {
				// Unreachable for a ParsedProviderManifest; the parser refuses it.
				throw new Error("package rate is not an exact per-unit price");
			}
			return {
				case: "perUnit" as const,
				value: { decimal: formatDecimal(unit), currency },
			};
		}
		case "graduated":
		case "volume":
			return {
				case: rate.case,
				value: { tiers: tiers(rate.value, currency) },
			};
		default:
			throw new Error("metered charge has no rate");
	}
}

function chargeComponent(charge: Charge, currency: string) {
	const base = {
		id: charge.id,
		selectors: { ...charge.when },
		fallback: false,
		invoiceBehavior: "separate-line",
	};
	const model = charge.model;
	if (model.case === "recurring") {
		const fixed = create(FixedChargeSchema, {
			cadence: model.value.interval,
			timing: model.value.timing === "" ? "advance" : model.value.timing,
			amount: { decimal: model.value.amount, currency },
			proration: "none",
		});
		if (model.value.per !== "") fixed.quantityDimension = model.value.per;
		return { base, variant: { case: "fixed" as const, value: fixed } };
	}
	if (model.case === "metered") {
		return {
			base,
			variant: {
				case: "usage" as const,
				value: {
					dimension: model.value.billable,
					timing: model.value.timing === "" ? "arrears" : model.value.timing,
					price: usagePrice(model.value, currency),
				},
			},
		};
	}
	throw new Error(`charge ${charge.id} is not rateable`);
}

function meter(billable: BillableDefinition) {
	return {
		dimension: billable.id,
		unit: billable.unit,
		aggregation: billable.aggregation === "" ? "sum" : billable.aggregation,
		rounding: {
			scope: "period",
			multiple: billable.increment === "" ? "1" : billable.increment,
			mode: "ceil",
		},
	};
}

function productBillables(product: BillingProduct): readonly string[] {
	const ids = new Set(product.billables);
	for (const plan of product.plans) {
		for (const charge of plan.charges) {
			if (charge.model.case === "metered") ids.add(charge.model.value.billable);
			if (charge.model.case === "recurring" && charge.model.value.per !== "") {
				ids.add(charge.model.value.per);
			}
		}
	}
	return [...ids].sort();
}

function externalCharge(plan: BillingPlan): Charge | undefined {
	return plan.charges.find((charge) => charge.model.case === "external");
}

/** Lower the billing section. `undefined` when the manifest declares none. */
export function toPricingCatalog(
	manifest: ParsedProviderManifest,
): BillingLowering | undefined {
	const billing = manifest.billing;
	const providerId = manifest.provider?.id;
	if (billing === undefined || providerId === undefined) return undefined;

	const billables = new Map(
		billing.billables.map((billable) => [billable.id, billable]),
	);
	const effective = create(EffectiveIntervalSchema, {
		start: billing.effectiveFrom,
	});
	if (billing.effectiveUntil !== undefined) {
		effective.end = billing.effectiveUntil;
	}
	const rated: RatedPlan[] = [];
	const unrated: UnratedPlan[] = [];
	const included: DeclaredIncludedUsage[] = [];
	const rateCards = [];

	for (const product of billing.products) {
		const productRef = pricingProductRef(providerId, product.id);
		for (const plan of product.plans) {
			for (const entry of plan.included) {
				included.push({
					productId: product.id,
					planId: plan.id,
					billable: entry.billable,
					quantity: entry.quantity,
					unit: billables.get(entry.billable)?.unit ?? "",
					reset: entry.reset === "" ? "monthly" : entry.reset,
				});
			}
			const external = externalCharge(plan);
			if (external !== undefined && external.model.case === "external") {
				unrated.push({
					productId: product.id,
					planId: plan.id,
					chargeId: external.id,
					model: external.model.value.model,
					reason: "PRICING_MODEL_UNSUPPORTED",
				});
				continue;
			}
			const rateCardId = `${productRef}/${plan.id}@${billing.version}`;
			rateCards.push({
				id: rateCardId,
				version: billing.version,
				currency: billing.currency,
				effective,
				charges: plan.charges.map((charge) =>
					chargeComponent(charge, billing.currency),
				),
			});
			rated.push({
				productId: product.id,
				planId: plan.id,
				productRef,
				rateCardId,
			});
		}
	}

	const catalog = create(PricingCatalogSchema, {
		schema: "hobo.pricing.catalog/v1",
		products: billing.products.map((product) => ({
			id: pricingProductRef(providerId, product.id),
			providerId,
			meters: productBillables(product).flatMap((id) => {
				const billable = billables.get(id);
				return billable === undefined ? [] : [meter(billable)];
			}),
		})),
		rateCards,
	});
	catalog.catalogHash = catalogHashOf(catalog);
	return { catalog, rated, unrated, included };
}
