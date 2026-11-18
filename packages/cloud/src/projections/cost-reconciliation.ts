
export interface EstimatedCost {
	readonly resource: string;
	readonly minorUnits: number;
}

export interface ActualCost {
	readonly resource: string;
	readonly minorUnits: number;
	readonly currency?: string;
}

export interface CostReconciliationInput {
	readonly deploymentId: string;
	readonly currency: string;
	readonly estimatePeriodMs: number;
	readonly observedWindowMs: number;
	readonly estimated: readonly EstimatedCost[];
	readonly actual: readonly ActualCost[];
	readonly toleranceBasisPoints?: number;
}

export type CostFindingKind = "variance" | "unestimated" | "unrealized";

export interface CostFinding {
	readonly kind: CostFindingKind;
	readonly resource: string;
	readonly estimatedMinorUnits: number;
	readonly actualMinorUnits: number;
	readonly varianceMinorUnits: number;
	readonly detail: string;
}

export type CostReconciliationStatus =
	| "reconciled"
	| "over"
	| "under"
	| "insufficient-window"
	| "currency-mismatch";

export interface CostTotals {
	readonly estimatedMinorUnits: number;
	readonly actualMinorUnits: number;
	readonly varianceMinorUnits?: number;
	readonly unestimatedMinorUnits: number;
	readonly unrealizedMinorUnits: number;
}

export interface CostReconciliationReport {
	readonly deploymentId: string;
	readonly currency: string;
	readonly status: CostReconciliationStatus;
	readonly coverage: number;
	readonly totals: CostTotals;
	readonly findings: readonly CostFinding[];
}

function sumBy(
	entries: readonly { resource: string; minorUnits: number }[],
): Map<string, number> {
	const totals = new Map<string, number>();
	for (const entry of entries)
		totals.set(
			entry.resource,
			(totals.get(entry.resource) ?? 0) + entry.minorUnits,
		);
	return totals;
}

function total(values: Iterable<number>): number {
	let sum = 0;
	for (const value of values) sum += value;
	return sum;
}

export function reconcileCost(
	input: CostReconciliationInput,
): CostReconciliationReport {
	const estimatedBy = sumBy(input.estimated);
	const actualBy = sumBy(input.actual);
	const estimatedMinorUnits = total(estimatedBy.values());
	const actualMinorUnits = total(actualBy.values());

	const coverage =
		input.estimatePeriodMs <= 0
			? 1
			: Math.min(1, input.observedWindowMs / input.estimatePeriodMs);

	const mixedCurrency = input.actual.some(
		(entry) =>
			entry.currency !== undefined && entry.currency !== input.currency,
	);

	if (mixedCurrency || coverage < 1) {
		return {
			deploymentId: input.deploymentId,
			currency: input.currency,
			status: mixedCurrency ? "currency-mismatch" : "insufficient-window",
			coverage,
			totals: {
				estimatedMinorUnits,
				actualMinorUnits,
				unestimatedMinorUnits: 0,
				unrealizedMinorUnits: 0,
			},
			findings: [],
		};
	}

	const tolerance = input.toleranceBasisPoints ?? 0;
	const findings: CostFinding[] = [];
	let unestimatedMinorUnits = 0;
	let unrealizedMinorUnits = 0;
	let reportableVariance = 0;

	for (const [resource, estimated] of estimatedBy) {
		const observed = actualBy.get(resource);
		if (observed === undefined) {
			unrealizedMinorUnits += estimated;
			findings.push({
				kind: "unrealized",
				resource,
				estimatedMinorUnits: estimated,
				actualMinorUnits: 0,
				varianceMinorUnits: 0,
				detail: `${resource} was estimated at ${estimated} but never charged for`,
			});
			continue;
		}
		const variance = observed - estimated;
		const allowed = (Math.abs(estimated) * tolerance) / 10_000;
		if (Math.abs(variance) <= allowed) continue;
		reportableVariance += variance;
		findings.push({
			kind: "variance",
			resource,
			estimatedMinorUnits: estimated,
			actualMinorUnits: observed,
			varianceMinorUnits: variance,
			detail: `${resource} was estimated at ${estimated} and cost ${observed}`,
		});
	}

	for (const [resource, observed] of actualBy) {
		if (estimatedBy.has(resource)) continue;
		unestimatedMinorUnits += observed;
		reportableVariance += observed;
		findings.push({
			kind: "unestimated",
			resource,
			estimatedMinorUnits: 0,
			actualMinorUnits: observed,
			varianceMinorUnits: observed,
			detail: `${resource} cost ${observed} and was never estimated`,
		});
	}

	findings.sort((a, b) => a.resource.localeCompare(b.resource));

	const varianceMinorUnits =
		actualMinorUnits - (estimatedMinorUnits - unrealizedMinorUnits);

	return {
		deploymentId: input.deploymentId,
		currency: input.currency,
		status:
			reportableVariance > 0
				? "over"
				: reportableVariance < 0
					? "under"
					: "reconciled",
		coverage,
		totals: {
			estimatedMinorUnits,
			actualMinorUnits,
			varianceMinorUnits,
			unestimatedMinorUnits,
			unrealizedMinorUnits,
		},
		findings,
	};
}
