import type {
	ChargeComponent,
	ProviderAgreement,
	WorkloadDelta,
} from "./_generated/pricing_pb.js";

function fixedQuantityMissing(
	charge: ChargeComponent,
	agreement: ProviderAgreement,
	workloads: readonly WorkloadDelta[],
): boolean {
	if (charge.variant.case !== "fixed") return false;
	const dimension = charge.variant.value.quantityDimension;
	if (dimension === undefined) return false;
	if (Object.hasOwn(agreement.quantities, dimension)) return false;
	return !workloads.some((workload) =>
		Object.hasOwn(workload.quantities, dimension),
	);
}

export function rateCardChargesIncomplete(
	charges: readonly ChargeComponent[],
	meterDimensions: ReadonlySet<string>,
	agreement: ProviderAgreement,
	workloads: readonly WorkloadDelta[],
): boolean {
	if (charges.length === 0) return true;
	return charges.some((charge) =>
		rateCardChargeIncomplete(charge, meterDimensions, agreement, workloads),
	);
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
		return !meterDimensions.has(charge.variant.value.dimension);
	}
	if (charge.variant.case === "fixed") {
		return fixedQuantityMissing(charge, agreement, workloads);
	}
	return false;
}