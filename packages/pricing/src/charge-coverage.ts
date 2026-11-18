import type {
	ChargeComponent,
	Money,
	ProviderAgreement,
	Tier,
	WorkloadDelta,
} from "./_generated/pricing_pb.js";

function moneyIncomplete(money: Money | undefined): boolean {
	return (
		money === undefined ||
		money.decimal.length === 0 ||
		money.currency.length === 0
	);
}

function tierIncomplete(tier: Tier): boolean {
	if (tier.from.length === 0) return true;
	return moneyIncomplete(tier.flatAmount) || moneyIncomplete(tier.unitAmount);
}

function usagePriceIncomplete(charge: ChargeComponent): boolean {
	if (charge.variant.case !== "usage") return false;
	const price = charge.variant.value.price;
	if (price.case === undefined) return true;
	if (price.case === "perUnit") {
		return (
			price.value.decimal.length === 0 || price.value.currency.length === 0
		);
	}
	if (price.case === "package") {
		const amount = price.value.packageAmount;
		return price.value.packageSize.length === 0 || moneyIncomplete(amount);
	}
	if (price.case === "graduated" || price.case === "volume") {
		if (price.value.tiers.length === 0) return true;
		return price.value.tiers.some(tierIncomplete);
	}
	return true;
}

function fixedQuantityMissing(
	charge: ChargeComponent,
	agreement: ProviderAgreement,
	workloads: readonly WorkloadDelta[],
): boolean {
	if (charge.variant.case !== "fixed") return false;
	const dimension = charge.variant.value.quantityDimension;
	if (dimension === undefined || dimension.length === 0) return false;
	if (Object.hasOwn(agreement.quantities, dimension)) return false;
	return !workloads.some(
		(workload) =>
			workload.agreementRef === agreement.id &&
			Object.hasOwn(workload.quantities, dimension),
	);
}

const QUOTABLE_AGREEMENT_STATUSES = new Set(["active", "past-due", "trialing"]);

export function referencedAgreementUnquotable(
	agreement: ProviderAgreement,
	workloads: readonly WorkloadDelta[],
): boolean {
	return (
		workloads.some((workload) => workload.agreementRef === agreement.id) &&
		!QUOTABLE_AGREEMENT_STATUSES.has(agreement.status)
	);
}

export function agreementRequiresRateCardValidation(
	agreement: ProviderAgreement,
	workloads: readonly WorkloadDelta[],
): boolean {
	if (agreement.status === "active" || agreement.status === "past-due") {
		return true;
	}
	if (agreement.status === "trialing") {
		return workloads.some((workload) => workload.agreementRef === agreement.id);
	}
	return false;
}

export function rateCardChargesIncomplete(
	charges: readonly ChargeComponent[],
	meterDimensions: ReadonlySet<string>,
	agreement: ProviderAgreement,
	workloads: readonly WorkloadDelta[],
): boolean {
	if (charges.length === 0) return true;
	if (
		charges.some((charge) =>
			rateCardChargeIncomplete(charge, meterDimensions, agreement, workloads),
		)
	) {
		return true;
	}
	const pricedMeters = new Set(
		charges
			.filter(
				(charge) =>
					charge.variant.case === "usage" && !usagePriceIncomplete(charge),
			)
			.map((charge) =>
				charge.variant.case === "usage" ? charge.variant.value.dimension : "",
			)
			.filter((dimension) => dimension.length > 0),
	);
	for (const dimension of meterDimensions) {
		if (!pricedMeters.has(dimension)) return true;
	}
	return false;
}

export function rateCardChargeIncomplete(
	charge: ChargeComponent,
	meterDimensions: ReadonlySet<string>,
	agreement: ProviderAgreement,
	workloads: readonly WorkloadDelta[],
): boolean {
	if (charge.base === undefined || charge.base.id.length === 0) return true;
	if (charge.variant.case === undefined) return true;
	if (charge.variant.case === "usage") {
		return (
			!meterDimensions.has(charge.variant.value.dimension) ||
			usagePriceIncomplete(charge)
		);
	}
	if (charge.variant.case === "fixed") {
		return (
			moneyIncomplete(charge.variant.value.amount) ||
			fixedQuantityMissing(charge, agreement, workloads)
		);
	}
	return true;
}
