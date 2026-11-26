import {
	parseResourceLifecycleObservation,
	type ResourceLifecycleObservation,
} from "@hobo/core";

export type HostingBillingResource = Pick<
	ResourceLifecycleObservation,
	"providerId" | "providerAccountId" | "productId" | "resourceId" | "physicalId"
>;
function resourceKey(row: HostingBillingResource) {
	return JSON.stringify([
		row.providerId,
		row.providerAccountId,
		row.productId,
		row.resourceId,
		row.physicalId,
	]);
}

/** Each record is one resource's disjoint charge allocation. Account-wide final
 * invoices must be partitioned by the trusted billing reader before reaching
 * this boundary; repeating a whole-account total for every resource overcounts. */
export function aggregateHostingBillingObservations(input: {
	readonly tenantId: string;
	readonly operationId: string;
	readonly providerAccountIds: ReadonlySet<string>;
	readonly records: readonly ResourceLifecycleObservation[];
	readonly requiredResources: readonly HostingBillingResource[];
	readonly nowMs: number;
	readonly maxAgeMs: number;
}) {
	const resources = new Set<string>();
	const payers = new Set<string>();
	const totals = new Map<string, number>();
	const evidenceRefs: string[] = [];
	let usageFinal = input.records.length > 0;
	let settledMicros = 0;
	for (const row of input.records) {
		if (!input.providerAccountIds.has(row.providerAccountId))
			throw new Error("billing evidence has a foreign payer");
		const key = resourceKey(row);
		if (resources.has(key))
			throw new Error("billing evidence repeats a native resource charge");
		const parsed = parseResourceLifecycleObservation(row, {
			tenantId: input.tenantId,
			operationId: input.operationId,
			providerId: row.providerId,
			providerAccountId: row.providerAccountId,
			productId: row.productId,
			resourceId: row.resourceId,
			nowMs: input.nowMs,
			maxAgeMs: input.maxAgeMs,
		});
		resources.add(key);
		payers.add(parsed.providerAccountId);
		usageFinal &&= parsed.usageFinal;
		settledMicros += parsed.settledMicros;
		const payerTotal =
			(totals.get(parsed.providerAccountId) ?? 0) + parsed.settledMicros;
		if (
			!Number.isSafeInteger(settledMicros) ||
			!Number.isSafeInteger(payerTotal)
		)
			throw new Error("actual hosting charges overflow safe money");
		totals.set(parsed.providerAccountId, payerTotal);
		evidenceRefs.push(parsed.usageEvidenceRef);
	}
	usageFinal &&=
		payers.size === input.providerAccountIds.size &&
		input.requiredResources.every((row) => resources.has(resourceKey(row)));
	return {
		usageFinal,
		settledMicros,
		evidenceRefs,
		providerAccountTotals: totals,
	};
}
