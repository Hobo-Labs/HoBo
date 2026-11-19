import type {
	PricingCatalog,
	ProviderAgreement,
	RateCard,
	WorkloadDelta,
} from "./_generated/pricing_pb.js";
import { resolveRateCard, selectChargeComponents } from "./catalog.js";
import { codeUnitPricingOrder } from "./ordering.js";
import { utcPricingTimeOrder } from "./time-order.js";

export function hasExplicitFixedChargeCoverage(
	rateCard: RateCard,
	agreement: ProviderAgreement,
	workload: WorkloadDelta,
	hasUsageMeters: boolean,
): boolean {
	const charges = selectChargeComponents(
		rateCard,
		workload,
		undefined,
		"fixed",
		codeUnitPricingOrder,
	);
	if (!hasUsageMeters && charges.length === 0) return false;
	return charges.every((charge) =>
		hasExplicitFixedQuantity(charge, agreement, [workload]),
	);
}

export function hasExplicitFixedQuantity(
	charge: RateCard["charges"][number],
	agreement: ProviderAgreement,
	workloads: readonly WorkloadDelta[],
): boolean {
	if (charge.variant.case !== "fixed") return false;
	const dimension = charge.variant.value.quantityDimension;
	return (
		dimension === undefined ||
		(dimension.length > 0 &&
			dimension.length <= 200 &&
			dimension.trim() === dimension &&
			!/[\p{Cc}]/u.test(dimension) &&
			Object.hasOwn(agreement.quantities, dimension) &&
			workloads.every((workload) =>
				Object.hasOwn(workload.quantities, dimension),
			))
	);
}

export function hasExplicitUnreferencedFixedCoverage(
	catalog: PricingCatalog,
	agreements: readonly ProviderAgreement[],
	workloads: readonly WorkloadDelta[],
	at: string,
	horizon: string,
): boolean {
	const referenced = new Set(
		workloads.map((workload) => workload.agreementRef),
	);
	return agreements.every((agreement) => {
		if (agreement.status !== "active" || referenced.has(agreement.id))
			return true;
		const rateCard = resolveRateCard(
			catalog,
			agreement,
			at,
			horizon,
			utcPricingTimeOrder,
		);
		const charges = selectChargeComponents(
			rateCard,
			undefined,
			undefined,
			"fixed",
			codeUnitPricingOrder,
		);
		return charges.every((charge) => {
			if (charge.variant.case !== "fixed") return false;
			const dimension = charge.variant.value.quantityDimension;
			return (
				dimension === undefined ||
				(dimension.length > 0 &&
					dimension.length <= 200 &&
					dimension.trim() === dimension &&
					!/[\p{Cc}]/u.test(dimension) &&
					Object.hasOwn(agreement.quantities, dimension))
			);
		});
	});
}
