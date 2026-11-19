import { create } from "@bufbuild/protobuf";
import {
	Aggregation,
	type CheckOutcomeRecord,
	CheckOutcomeRecordSchema,
	Cohort,
	Comparator,
	type EvidenceObservationRecord,
	type HealthQueryRecord,
	type ReasonRecord,
	VerificationVerdict,
} from "../_generated/cd_pb.js";
import { reason, type VerificationReasonCode } from "./reasons.js";
import {
	BURN_RATE_UNIT,
	comparisonCheckId,
	ERROR_BUDGET_CHECK,
	type ParsedVerificationSpec,
	probeCheckId,
	RATIO_UNIT,
	SLO_BUDGET_CHECK,
	SLO_BURN_CHECK,
	SLO_CHECK,
	suiteCheckId,
	thresholdCheckId,
} from "./spec.js";
import { compareCohorts } from "./stats.js";

export type EvaluationInput = Readonly<{
	spec: ParsedVerificationSpec;
	cohortAware: boolean;
	evidence: readonly EvidenceObservationRecord[];
	startedAtMs: number;
	atMs: number;

	unavailable?: ReadonlySet<string>;
}>;

export type Evaluation = Readonly<{
	complete: boolean;
	verdict: VerificationVerdict;
	checks: readonly CheckOutcomeRecord[];
	reasons: readonly ReasonRecord[];
}>;

type Decided = CheckOutcomeRecord | "pending";

type Clock = Readonly<{ windowEnded: boolean; deadlinePassed: boolean }>;

export function thresholdCohort(cohortAware: boolean): Cohort {
	return cohortAware ? Cohort.CANARY : Cohort.ALL;
}

function outcome(
	check: string,
	verdict: VerificationVerdict,
	fields: Partial<
		Pick<
			CheckOutcomeRecord,
			"statistic" | "pValue" | "samplesCanary" | "samplesBaseline"
		>
	>,
	why?: Readonly<{ code: VerificationReasonCode; message: string }>,
): CheckOutcomeRecord {
	const record = create(CheckOutcomeRecordSchema, {
		check,
		verdict,
		...fields,
	});
	if (why) record.reason = reason(why.code, why.message, check);
	return record;
}

function samplesOf(
	evidence: readonly EvidenceObservationRecord[],
	check: string,
	cohort?: Cohort,
): number[] {
	return evidence
		.filter(
			(item) =>
				item.signal === check &&
				(cohort === undefined || item.cohort === cohort),
		)
		.map((item) => item.value);
}

function noData(
	check: string,
	failOnNoData: boolean,
	detail: string,
): CheckOutcomeRecord {
	return outcome(
		check,
		failOnNoData ? VerificationVerdict.FAIL : VerificationVerdict.INCONCLUSIVE,
		{},
		{
			code: "verification-no-data",
			message: detail,
		},
	);
}

function sufficiency(
	check: string,
	counts: readonly number[],
	required: number,
	clock: Clock,
	unavailable: boolean,
	failOnNoData: boolean,
): Decided | undefined {
	const empty = counts.some((count) => count === 0);
	const short = counts.some((count) => count < required);
	if (
		!clock.deadlinePassed &&
		(unavailable || short) &&
		!(empty && !unavailable)
	)
		return "pending";
	if (empty)
		return noData(check, failOnNoData, `no samples for ${check} in the window`);
	if (short) {
		return outcome(
			check,
			VerificationVerdict.INCONCLUSIVE,
			{ samplesCanary: counts[0] ?? 0, samplesBaseline: counts[1] ?? 0 },
			{
				code: "verification-insufficient-observations",
				message: `${counts.join("/")} samples, ${required} required, at the progress deadline`,
			},
		);
	}
	return undefined;
}

function invalidSamples(
	query: HealthQueryRecord,
	values: readonly number[],
): boolean {
	return values.some(
		(value) =>
			!Number.isFinite(value) ||
			(query.unit === RATIO_UNIT && (value < 0 || value > 1)),
	);
}

function nearestRank(sorted: readonly number[], quantile: number): number {
	const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
	return sorted[index] ?? Number.NaN;
}

function scaledTotal(values: readonly number[]) {
	const scale = values.reduce(
		(largest, value) => Math.max(largest, Math.abs(value)),
		0,
	);
	return {
		scale,
		total: values.reduce((sum, value) => sum + value / scale, 0),
	};
}

export function aggregate(
	values: readonly number[],
	aggregation: Aggregation,
): number {
	const sorted = [...values].sort((a, b) => a - b);
	switch (aggregation) {
		case Aggregation.MEAN: {
			const total = sorted.reduce((sum, value) => sum + value, 0);
			if (Number.isFinite(total) || !sorted.every(Number.isFinite))
				return total / sorted.length;
			const scaled = scaledTotal(sorted);
			return (scaled.total / sorted.length) * scaled.scale;
		}
		case Aggregation.P50:
			return nearestRank(sorted, 0.5);
		case Aggregation.P95:
			return nearestRank(sorted, 0.95);
		case Aggregation.P99:
			return nearestRank(sorted, 0.99);
		case Aggregation.MAX:
			return sorted[sorted.length - 1] ?? Number.NaN;
		case Aggregation.SUM: {
			const total = sorted.reduce((sum, value) => sum + value, 0);
			if (Number.isFinite(total) || !sorted.every(Number.isFinite))
				return total;
			const scaled = scaledTotal(sorted);
			return scaled.total * scaled.scale;
		}
		default:
			return Number.NaN;
	}
}

export function holds(
	value: number,
	comparator: Comparator,
	bound: number,
): boolean {
	switch (comparator) {
		case Comparator.LT:
			return value < bound;
		case Comparator.LTE:
			return value <= bound;
		case Comparator.GT:
			return value > bound;
		case Comparator.GTE:
			return value >= bound;
		default:
			return false;
	}
}

function comparatorText(comparator: Comparator): string {
	switch (comparator) {
		case Comparator.LT:
			return "<";
		case Comparator.LTE:
			return "<=";
		case Comparator.GT:
			return ">";
		case Comparator.GTE:
			return ">=";
		default:
			return "?";
	}
}

function evaluateSlo(input: EvaluationInput): Decided {
	const gate = input.spec.sloGate;
	if (!gate) return "pending";
	const cohort = thresholdCohort(input.cohortAware);
	const fromMs = Math.max(
		input.startedAtMs,
		input.atMs - Number(input.spec.windowMs),
	);
	const maxAgeMs = Number(gate.maxSampleAgeMs);
	const series = new Map<string, Map<number, number>>();
	for (const check of [SLO_BURN_CHECK, SLO_BUDGET_CHECK]) {
		const points = input.evidence.filter(
			(item) => item.signal === check && item.cohort === cohort,
		);
		const timestamps = new Map<number, number>();
		const keys = new Set<string>();
		for (const point of points) {
			const at = Date.parse(point.observedAt);
			if (!Number.isFinite(at) || !point.seriesKey) return "pending";
			if (at < fromMs) continue;
			if (at > input.atMs || !point.healthy || !Number.isFinite(point.value))
				return "pending";
			if (point.value < 0 || (check === SLO_BUDGET_CHECK && point.value > 1))
				return "pending";
			keys.add(point.seriesKey);
			const previous = timestamps.get(at);
			if (previous !== undefined && previous !== point.value) return "pending";
			timestamps.set(at, point.value);
		}
		if (keys.size !== 1 || timestamps.size === 0) return "pending";
		series.set(check, timestamps);
	}
	const burn = series.get(SLO_BURN_CHECK);
	const budget = series.get(SLO_BUDGET_CHECK);
	if (!burn || !budget) return "pending";
	const timestamps = [...new Set([...burn.keys(), ...budget.keys()])].sort(
		(a, b) => a - b,
	);
	let burnBreaches = 0;
	let budgetBreaches = 0;
	let healthy = 0;
	let last = -1;
	for (const at of timestamps) {
		const burnRate = burn.get(at);
		const remaining = budget.get(at);
		if (
			burnRate === undefined ||
			remaining === undefined ||
			(last >= 0 && at - last > maxAgeMs)
		) {
			burnBreaches = 0;
			budgetBreaches = 0;
			healthy = 0;
		}
		if (burnRate !== undefined && remaining !== undefined) {
			burnBreaches =
				burnRate >= (gate.rollbackBurnRate ?? 12) ? burnBreaches + 1 : 0;
			budgetBreaches =
				remaining <= (gate.minRemainingBudgetRatio ?? 0.08)
					? budgetBreaches + 1
					: 0;
			healthy =
				burnRate < (gate.holdBurnRate ?? 1) &&
				remaining > (gate.holdRemainingBudgetRatio ?? 0.2)
					? healthy + 1
					: 0;
		}
		last = at;
	}
	if (
		last < 0 ||
		input.atMs - last > maxAgeMs ||
		!burn.has(last) ||
		!budget.has(last)
	)
		return "pending";
	if (
		burnBreaches >= gate.sustainedBreachCount ||
		budgetBreaches >= gate.sustainedBreachCount
	)
		return outcome(
			SLO_CHECK,
			VerificationVerdict.FAIL,
			{ samplesCanary: Math.max(burnBreaches, budgetBreaches) },
			{
				code: "verification-slo-breach",
				message:
					"SLO burn or remaining budget breached its rollback threshold in consecutive samples",
			},
		);
	if (healthy >= gate.sustainedHealthyCount)
		return outcome(SLO_CHECK, VerificationVerdict.PASS, {
			samplesCanary: healthy,
		});
	return "pending";
}

export function evaluateVerification(input: EvaluationInput): Evaluation {
	const { spec, evidence } = input;
	const windowEnd = input.startedAtMs + Number(spec.windowMs);
	const clock: Clock = {
		windowEnded: input.atMs >= windowEnd,
		deadlinePassed:
			input.atMs >= input.startedAtMs + Number(spec.progressDeadlineMs),
	};
	const required = spec.requiredObservations;
	const unavailable = input.unavailable ?? new Set<string>();
	const decided = new Map<string, Decided>();
	const failOnNoData = spec.failOnNoData;

	for (const threshold of spec.thresholds) {
		const query = threshold.query;
		if (!query) continue;
		const check = thresholdCheckId(query);
		const values = samplesOf(
			evidence,
			check,
			thresholdCohort(input.cohortAware),
		);
		const early = sufficiency(
			check,
			[values.length],
			required,
			clock,
			unavailable.has(check),
			failOnNoData,
		);
		if (early) {
			decided.set(check, early);
			continue;
		}
		if (invalidSamples(query, values)) {
			decided.set(
				check,
				outcome(
					check,
					VerificationVerdict.FAIL,
					{ samplesCanary: values.length },
					{
						code: "verification-invalid-sample",
						message: `${check} has non-finite or out-of-range samples`,
					},
				),
			);
			continue;
		}
		const value = aggregate(values, threshold.aggregation);
		if (!Number.isFinite(value)) {
			decided.set(
				check,
				outcome(
					check,
					VerificationVerdict.FAIL,
					{ samplesCanary: values.length },
					{
						code: "verification-invalid-sample",
						message: `${check} has a non-finite aggregate`,
					},
				),
			);
			continue;
		}
		const ok = holds(value, threshold.comparator, threshold.value);
		decided.set(
			check,
			outcome(
				check,
				ok ? VerificationVerdict.PASS : VerificationVerdict.FAIL,
				{ statistic: value, samplesCanary: values.length },
				ok
					? undefined
					: {
							code: "verification-threshold-breached",
							message: `${Aggregation[threshold.aggregation]} ${value} is not ${comparatorText(threshold.comparator)} ${threshold.value}`,
						},
			),
		);
	}

	for (const comparison of spec.comparisons) {
		const query = comparison.query;
		if (!query) continue;
		const check = comparisonCheckId(query);
		if (!input.cohortAware) {
			decided.set(
				check,
				outcome(
					check,
					VerificationVerdict.FAIL,
					{},
					{
						code: "verification-cohort-unavailable",
						message: `${check} compares canary with baseline, but this rollout has no baseline cohort`,
					},
				),
			);
			continue;
		}
		const canary = samplesOf(evidence, check, Cohort.CANARY);
		const baseline = samplesOf(evidence, check, Cohort.BASELINE);
		const minimum = Math.max(required, comparison.minSamples);
		const early = sufficiency(
			check,
			[canary.length, baseline.length],
			minimum,
			clock,
			unavailable.has(check),
			failOnNoData,
		);
		if (early) {
			decided.set(check, early);
			continue;
		}
		if (invalidSamples(query, canary) || invalidSamples(query, baseline)) {
			decided.set(
				check,
				outcome(
					check,
					VerificationVerdict.FAIL,
					{ samplesCanary: canary.length, samplesBaseline: baseline.length },
					{
						code: "verification-invalid-sample",
						message: `${check} has non-finite or out-of-range samples`,
					},
				),
			);
			continue;
		}
		const result = compareCohorts({
			canary,
			baseline,
			direction: comparison.direction,
			sensitivity: comparison.sensitivity,
		});
		decided.set(
			check,
			outcome(
				check,
				result.failed ? VerificationVerdict.FAIL : VerificationVerdict.PASS,
				{
					statistic: result.u,
					pValue: result.p,
					samplesCanary: canary.length,
					samplesBaseline: baseline.length,
				},
				result.failed
					? {
							code: "verification-canary-worse",
							message: `U=${result.u} p=${result.p} < alpha ${result.alpha} (${result.method})`,
						}
					: undefined,
			),
		);
	}

	for (const probe of spec.probes) {
		const check = probeCheckId(probe.name);
		const attempts = evidence.filter((item) => item.signal === check);
		const early = sufficiency(
			check,
			[attempts.length],
			required,
			clock,
			false,
			failOnNoData,
		);
		if (early) {
			decided.set(check, early);
			continue;
		}
		const ratio =
			attempts.filter((item) => item.healthy).length / attempts.length;
		const ok = ratio >= probe.minSuccessRatio;
		decided.set(
			check,
			outcome(
				check,
				ok ? VerificationVerdict.PASS : VerificationVerdict.FAIL,
				{ statistic: ratio, samplesCanary: attempts.length },
				ok
					? undefined
					: {
							code: "verification-probe-failed",
							message: `success ratio ${ratio} < ${probe.minSuccessRatio}`,
						},
			),
		);
	}

	for (const suite of spec.suites) {
		const check = suiteCheckId(suite.suite);
		const runs = evidence.filter((item) => item.signal === check);
		const last = runs[runs.length - 1];
		if (!last) {
			decided.set(
				check,
				clock.deadlinePassed
					? noData(
							check,
							failOnNoData,
							`suite ${suite.suite} produced no result`,
						)
					: "pending",
			);
			continue;
		}
		decided.set(
			check,
			outcome(
				check,
				last.healthy ? VerificationVerdict.PASS : VerificationVerdict.FAIL,
				{ statistic: last.value, samplesCanary: runs.length },
				last.healthy
					? undefined
					: {
							code: "verification-suite-failed",
							message: `suite ${suite.suite} failed`,
						},
			),
		);
	}

	if (spec.maxErrorBudgetBurn > 0) {
		const burnChecks = [
			...spec.thresholds
				.filter((t) => t.query?.unit === BURN_RATE_UNIT)
				.map((t) => (t.query ? thresholdCheckId(t.query) : "")),
			...spec.comparisons
				.filter((c) => c.query?.unit === BURN_RATE_UNIT)
				.map((c) => (c.query ? comparisonCheckId(c.query) : "")),
		];
		const cohort = thresholdCohort(input.cohortAware);
		if (burnChecks.some((check) => decided.get(check) === "pending")) {
			decided.set(ERROR_BUDGET_CHECK, "pending");
		} else {
			const burn = burnChecks
				.flatMap((check) => samplesOf(evidence, check, cohort))
				.filter(Number.isFinite);
			if (burn.length === 0) {
				decided.set(
					ERROR_BUDGET_CHECK,
					noData(
						ERROR_BUDGET_CHECK,
						failOnNoData,
						"no burn-rate samples in the window",
					),
				);
			} else {
				const peak = burn.reduce(
					(maximum, value) => Math.max(maximum, value),
					Number.NEGATIVE_INFINITY,
				);
				const ok = peak <= spec.maxErrorBudgetBurn;
				decided.set(
					ERROR_BUDGET_CHECK,
					outcome(
						ERROR_BUDGET_CHECK,
						ok ? VerificationVerdict.PASS : VerificationVerdict.FAIL,
						{ statistic: peak, samplesCanary: burn.length },
						ok
							? undefined
							: {
									code: "verification-error-budget-exhausted",
									message: `burn rate ${peak} > ${spec.maxErrorBudgetBurn}`,
								},
					),
				);
			}
		}
	}

	if (spec.sloGate) decided.set(SLO_CHECK, evaluateSlo(input));

	const pending = [...decided.values()].some((value) => value === "pending");
	const failedBeforePending =
		spec.sloGate &&
		[...decided.values()].some(
			(value) =>
				value !== "pending" && value.verdict === VerificationVerdict.FAIL,
		);
	if (!clock.windowEnded || (pending && !failedBeforePending)) {
		return {
			complete: false,
			verdict: VerificationVerdict.UNSPECIFIED,
			checks: [],
			reasons: [],
		};
	}
	const checks = [...decided.values()].filter(
		(value): value is CheckOutcomeRecord => value !== "pending",
	);
	const failed = checks.some(
		(check) => check.verdict === VerificationVerdict.FAIL,
	);
	const inconclusive = checks.some(
		(check) => check.verdict === VerificationVerdict.INCONCLUSIVE,
	);
	const verdict = failed
		? VerificationVerdict.FAIL
		: inconclusive
			? VerificationVerdict.INCONCLUSIVE
			: VerificationVerdict.PASS;
	const reasons = checks.flatMap((check) =>
		check.reason ? [check.reason] : [],
	);
	if (verdict === VerificationVerdict.INCONCLUSIVE && clock.deadlinePassed) {
		reasons.push(
			reason(
				"verification-deadline-exceeded",
				"the progress deadline passed before every check had evidence",
			),
		);
	}
	return { complete: true, verdict, checks, reasons };
}

export function qualifies(verdict: VerificationVerdict): boolean {
	return verdict === VerificationVerdict.PASS;
}
