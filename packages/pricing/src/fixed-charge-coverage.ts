import type {
	ProviderAgreement,
	RateCard,
	WorkloadDelta,
} from "./_generated/pricing_pb.js";
import { selectChargeComponents } from "./catalog.js";
import { codeUnitPricingOrder } from "./ordering.js";

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
	return charges.every((charge) => {
		if (charge.variant.case !== "fixed") return false;
		const dimension = charge.variant.value.quantityDimension;
		return (
			dimension === undefined ||
			(dimension.length > 0 &&
				dimension.length <= 200 &&
				dimension.trim() === dimension &&
				!/[\p{Cc}]/u.test(dimension) &&
				Object.hasOwn(agreement.quantities, dimension) &&
				Object.hasOwn(workload.quantities, dimension))
		);
	});
}
