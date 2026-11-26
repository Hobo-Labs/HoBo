/**
 * Estimate versus actual: the comparison nobody in the FinOps cohort makes.
 *
 * Infracost estimates at plan time and never sees the bill, so it structurally
 * cannot learn that its estimates are wrong. Kubecost, Vantage and OpenCost
 * measure the bill and never see the estimate. The loop is open in every
 * product in the corpus, and it is open because closing it means holding both
 * facts in one authoritative place — which is exactly what an append-only
 * deployment log is (ADR-0135).
 *
 * So this is a derivation, not a service: a pure function from a recorded
 * estimate plus observed actuals to a variance report. No new event, no stored
 * flag, no reconciliation job.
 *
 * ## Why the report is shaped defensively
 *
 * A cost surface gets exactly one chance with a finance team. The three ways
 * this class of report loses that chance are all structural, so they are all
 * handled here rather than left to the caller:
 *
 * **It must sum to the invoice.** An actual with no matching estimate is
 * reported as `unestimated` and counted in the total. Dropping it would make
 * the report disagree with the bill, and OpenCost's idle-as-residual design
 * exists precisely because a surface that quietly omits a line is one nobody
 * trusts twice.
 *
 * **A short window is not a saving.** Three days of actuals against a month's
 * estimate is a 90% underspend that is entirely an artifact of the clock.
 * Below full coverage the status is `insufficient-window` and no variance is
 * computed at all — the totals are still reported, because refusing the
 * comparison is not refusing the facts.
 *
 * **An estimate for something never built is not an underspend.** It is an
 * estimate that was never tested. Folding it into the variance would let a
 * deployment that half-failed read as good cost control, so `unrealized` is a
 * separate line that stays out of the variance.
 *
 * ## Money
 *
 * Integer minor units, one currency per report, no floating point anywhere.
 * The repo currently carries four incompatible money conventions — decimal
 * strings on the catalog, floats named `*Usd` in the broker, minor units in
 * the billing aggregator — and float accumulation is how a total ends up a
 * cent away from the invoice. A cent is enough to get the whole surface
 * disbelieved, so this module takes the one representation that cannot drift.
 * Mixed currencies are refused rather than summed: without an FX rate, adding
 * them produces a number that is wrong in a way no reader can see.
 */

/** A plan-time estimate for one resource, in minor units of the report's currency. */
export interface EstimatedCost {
	readonly resource: string;
	readonly minorUnits: number;
}

/**
 * An observed charge. Bills arrive as many lines per resource, so repeats for
 * one resource are summed rather than treated as a conflict.
 */
export interface ActualCost {
	readonly resource: string;
	readonly minorUnits: number;
	/** Defaults to the report's currency. A different one refuses the report. */
	readonly currency?: string;
}

export interface CostReconciliationInput {
	readonly deploymentId: string;
	readonly currency: string;
	/** The span the estimate describes — a month's estimate is 30 days here. */
	readonly estimatePeriodMs: number;
	/** How much of that span the actuals actually cover. */
	readonly observedWindowMs: number;
	readonly estimated: readonly EstimatedCost[];
	readonly actual: readonly ActualCost[];
	/**
	 * How far a resource may diverge before it is reported, in basis points of
	 * its estimate. Defaults to 0 — exact comparison — so a caller that wants
	 * slack has to say how much. Metered billing rounds, and a report that
	 * fires on every cent grows an ignore-list by the second week.
	 */
	readonly toleranceBasisPoints?: number;
}

/**
 * - `variance` — estimated and observed, and they differ beyond tolerance.
 * - `unestimated` — charged for, never estimated.
 * - `unrealized` — estimated, never charged for.
 */
export type CostFindingKind = "variance" | "unestimated" | "unrealized";

export interface CostFinding {
	readonly kind: CostFindingKind;
	readonly resource: string;
	readonly estimatedMinorUnits: number;
	readonly actualMinorUnits: number;
	readonly varianceMinorUnits: number;
	/** One sentence a human can act on without opening the bill. */
	readonly detail: string;
}

/**
 * - `reconciled` — compared, and nothing diverged.
 * - `over` / `under` — compared, and the total went the named way.
 * - `insufficient-window` — not compared; the actuals do not cover the period.
 * - `currency-mismatch` — not compared; an actual is in another currency.
 */
export type CostReconciliationStatus =
	| "reconciled"
	| "over"
	| "under"
	| "insufficient-window"
	| "currency-mismatch";

export interface CostTotals {
	readonly estimatedMinorUnits: number;
	readonly actualMinorUnits: number;
	/** Actual minus estimated. Absent when the comparison was refused. */
	readonly varianceMinorUnits?: number;
	readonly unestimatedMinorUnits: number;
	readonly unrealizedMinorUnits: number;
}

export interface CostReconciliationReport {
	readonly deploymentId: string;
	readonly currency: string;
	readonly status: CostReconciliationStatus;
	/** Observed window over estimate period, capped at 1. */
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

	// Both refusals report the totals anyway. Withholding the facts as well as
	// the comparison would leave a caller with nothing at all to show.
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
	/**
	 * The part of the variance the report actually reported. Tolerance-suppressed
	 * differences and unrealized estimates contribute nothing, so the status can
	 * never say "over" beside an empty finding list — a summary that contradicts
	 * the detail sends an operator hunting for a divergence the report just said
	 * was not there. The exact figure stays in `totals`, which is what has to
	 * agree with the invoice.
	 */
	let reportableVariance = 0;

	for (const [resource, estimated] of estimatedBy) {
		const observed = actualBy.get(resource);
		if (observed === undefined) {
			// Never charged for, so never tested. Not a saving.
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
		// Basis points of the estimate, compared without division so an estimate
		// of zero does not have to be special-cased into infinity.
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
		// Never dropped: the report has to sum to the invoice.
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

	// Unrealized estimates are excluded from both sides of the variance: a
	// resource nobody built neither overspent nor underspent.
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
