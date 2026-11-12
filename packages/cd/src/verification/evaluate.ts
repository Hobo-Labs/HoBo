// The pure verdict function (D9, I5, I8). Given a parsed spec, the evidence
// recorded on a cd-verification stream and an instant, it decides every check
// and the overall verdict. The engine calls it live; replay calls it with the
// recorded evidence and finished_at and must get the same answer.
//
// Fail closed: no data is FAIL (or INCONCLUSIVE when fail_on_no_data is
// false), never PASS; a check that still lacks evidence at the progress
// deadline is INCONCLUSIVE, which the rollout treats as FAIL.
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
	/**
	 * Checks whose health source refused at this instant. Live only: such a
	 * check stays pending (it is retried) until the progress deadline, after
	 * which an empty check is no data like any other.
	 */
	unavailable?: ReadonlySet<string>;
}>;

export type Evaluation = Readonly<{
	/** False while any check is still waiting for evidence before the deadline. */
	complete: boolean;
	verdict: VerificationVerdict;
	checks: readonly CheckOutcomeRecord[];
	reasons: readonly ReasonRecord[];
}>;

type Decided = CheckOutcomeRecord | "pending";

type Clock = Readonly<{ windowEnded: boolean; deadlinePassed: boolean }>;

/** The cohort a threshold reads: the canary when traffic is split, else everything. */
export function thresholdCohort(cohortAware: boolean): Cohort {
	return cohortAware ? Cohort.CANARY : Cohort.ALL;
}

function outcome(
	check: string,
	verdict: VerificationVerdict,
	fields: Partial<Pick<CheckOutcomeRecord, "statistic" | "pValue" | "samplesCanary" | "samplesBaseline">>,
	why?: Readonly<{ code: VerificationReasonCode; message: string }>,
): CheckOutcomeRecord {
	const record = create(CheckOutcomeRecordSchema, { check, verdict, ...fields });
	if (why) record.reason = reason(why.code, why.message, check);
	return record;
}

function samplesOf(evidence: readonly EvidenceObservationRecord[], check: string, cohort?: Cohort): number[] {
	return evidence.filter((item) => item.signal === check && (cohort === undefined || item.cohort === cohort)).map((item) => item.value);
}

function noData(check: string, failOnNoData: boolean, detail: string): CheckOutcomeRecord {
	return outcome(check, failOnNoData ? VerificationVerdict.FAIL : VerificationVerdict.INCONCLUSIVE, {}, {
		code: "verification-no-data",
		message: detail,
	});
}

/** Shared "enough evidence yet?" rule for every sampled check. */
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
	if (!clock.deadlinePassed && (unavailable || short) && !(empty && !unavailable)) return "pending";
	if (empty) return noData(check, failOnNoData, `no samples for ${check} in the window`);
	if (short) {
		return outcome(check, VerificationVerdict.INCONCLUSIVE, { samplesCanary: counts[0] ?? 0, samplesBaseline: counts[1] ?? 0 }, {
			code: "verification-insufficient-observations",
			message: `${counts.join("/")} samples, ${required} required, at the progress deadline`,
		});
	}
	return undefined;
}

function invalidSamples(query: HealthQueryRecord, values: readonly number[]): boolean {
	return values.some((value) => !Number.isFinite(value) || (query.unit === RATIO_UNIT && (value < 0 || value > 1)));
}

function nearestRank(sorted: readonly number[], quantile: number): number {
	const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
	return sorted[index] ?? Number.NaN;
}

/** Thresholds per aggregation; percentiles use the nearest-rank method. */
export function aggregate(values: readonly number[], aggregation: Aggregation): number {
	const sorted = [...values].sort((a, b) => a - b);
	switch (aggregation) {
		case Aggregation.MEAN:
			return sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
		case Aggregation.P50:
			return nearestRank(sorted, 0.5);
		case Aggregation.P95:
			return nearestRank(sorted, 0.95);
		case Aggregation.P99:
			return nearestRank(sorted, 0.99);
		case Aggregation.MAX:
			return sorted[sorted.length - 1] ?? Number.NaN;
		case Aggregation.SUM:
			return sorted.reduce((sum, value) => sum + value, 0);
		default:
			return Number.NaN;
	}
}

export function holds(value: number, comparator: Comparator, bound: number): boolean {
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

const COMPARATOR_TEXT: Readonly<Record<number, string>> = {
	[Comparator.LT]: "<",
	[Comparator.LTE]: "<=",
	[Comparator.GT]: ">",
	[Comparator.GTE]: ">=",
};

export function evaluateVerification(input: EvaluationInput): Evaluation {
	const { spec, evidence } = input;
	const windowEnd = input.startedAtMs + Number(spec.windowMs);
	const clock: Clock = {
		windowEnded: input.atMs >= windowEnd,
		deadlinePassed: input.atMs >= input.startedAtMs + Number(spec.progressDeadlineMs),
	};
	const required = spec.requiredObservations;
	const unavailable = input.unavailable ?? new Set<string>();
	const decided = new Map<string, Decided>();
	const failOnNoData = spec.failOnNoData;

	for (const threshold of spec.thresholds) {
		const query = threshold.query;
		if (!query) continue;
		const check = thresholdCheckId(query);
		const values = samplesOf(evidence, check, thresholdCohort(input.cohortAware));
		const early = sufficiency(check, [values.length], required, clock, unavailable.has(check), failOnNoData);
		if (early) {
			decided.set(check, early);
			continue;
		}
		if (invalidSamples(query, values)) {
			decided.set(check, outcome(check, VerificationVerdict.FAIL, { samplesCanary: values.length }, {
				code: "verification-invalid-sample",
				message: `${check} has non-finite or out-of-range samples`,
			}));
			continue;
		}
		const value = aggregate(values, threshold.aggregation);
		const ok = holds(value, threshold.comparator, threshold.value);
		decided.set(
			check,
			outcome(check, ok ? VerificationVerdict.PASS : VerificationVerdict.FAIL, { statistic: value, samplesCanary: values.length }, ok
				? undefined
				: {
						code: "verification-threshold-breached",
						message: `${Aggregation[threshold.aggregation]} ${value} is not ${COMPARATOR_TEXT[threshold.comparator] ?? "?"} ${threshold.value}`,
					}),
		);
	}

	for (const comparison of spec.comparisons) {
		const query = comparison.query;
		if (!query) continue;
		const check = comparisonCheckId(query);
		if (!input.cohortAware) {
			decided.set(check, outcome(check, VerificationVerdict.FAIL, {}, {
				code: "verification-cohort-unavailable",
				message: `${check} compares canary with baseline, but this rollout has no baseline cohort`,
			}));
			continue;
		}
		const canary = samplesOf(evidence, check, Cohort.CANARY);
		const baseline = samplesOf(evidence, check, Cohort.BASELINE);
		const minimum = Math.max(required, comparison.minSamples);
		const early = sufficiency(check, [canary.length, baseline.length], minimum, clock, unavailable.has(check), failOnNoData);
		if (early) {
			decided.set(check, early);
			continue;
		}
		if (invalidSamples(query, canary) || invalidSamples(query, baseline)) {
			decided.set(check, outcome(check, VerificationVerdict.FAIL, { samplesCanary: canary.length, samplesBaseline: baseline.length }, {
				code: "verification-invalid-sample",
				message: `${check} has non-finite or out-of-range samples`,
			}));
			continue;
		}
		const result = compareCohorts({ canary, baseline, direction: comparison.direction, sensitivity: comparison.sensitivity });
		decided.set(
			check,
			outcome(
				check,
				result.failed ? VerificationVerdict.FAIL : VerificationVerdict.PASS,
				{ statistic: result.u, pValue: result.p, samplesCanary: canary.length, samplesBaseline: baseline.length },
				result.failed
					? { code: "verification-canary-worse", message: `U=${result.u} p=${result.p} < alpha ${result.alpha} (${result.method})` }
					: undefined,
			),
		);
	}

	for (const probe of spec.probes) {
		const check = probeCheckId(probe.name);
		const attempts = evidence.filter((item) => item.signal === check);
		const early = sufficiency(check, [attempts.length], required, clock, false, failOnNoData);
		if (early) {
			decided.set(check, early);
			continue;
		}
		const ratio = attempts.filter((item) => item.healthy).length / attempts.length;
		const ok = ratio >= probe.minSuccessRatio;
		decided.set(
			check,
			outcome(check, ok ? VerificationVerdict.PASS : VerificationVerdict.FAIL, { statistic: ratio, samplesCanary: attempts.length }, ok
				? undefined
				: { code: "verification-probe-failed", message: `success ratio ${ratio} < ${probe.minSuccessRatio}` }),
		);
	}

	for (const suite of spec.suites) {
		const check = suiteCheckId(suite.suite);
		const runs = evidence.filter((item) => item.signal === check);
		const last = runs[runs.length - 1];
		if (!last) {
			decided.set(check, clock.deadlinePassed ? noData(check, failOnNoData, `suite ${suite.suite} produced no result`) : "pending");
			continue;
		}
		decided.set(
			check,
			outcome(check, last.healthy ? VerificationVerdict.PASS : VerificationVerdict.FAIL, { statistic: last.value, samplesCanary: runs.length }, last.healthy
				? undefined
				: { code: "verification-suite-failed", message: `suite ${suite.suite} failed` }),
		);
	}

	if (spec.maxErrorBudgetBurn > 0) {
		const burnChecks = [
			...spec.thresholds.filter((t) => t.query?.unit === BURN_RATE_UNIT).map((t) => (t.query ? thresholdCheckId(t.query) : "")),
			...spec.comparisons.filter((c) => c.query?.unit === BURN_RATE_UNIT).map((c) => (c.query ? comparisonCheckId(c.query) : "")),
		];
		const cohort = thresholdCohort(input.cohortAware);
		if (burnChecks.some((check) => decided.get(check) === "pending")) {
			decided.set(ERROR_BUDGET_CHECK, "pending");
		} else {
			const burn = burnChecks.flatMap((check) => samplesOf(evidence, check, cohort)).filter(Number.isFinite);
			if (burn.length === 0) {
				decided.set(ERROR_BUDGET_CHECK, noData(ERROR_BUDGET_CHECK, failOnNoData, "no burn-rate samples in the window"));
			} else {
				const peak = Math.max(...burn);
				const ok = peak <= spec.maxErrorBudgetBurn;
				decided.set(
					ERROR_BUDGET_CHECK,
					outcome(ERROR_BUDGET_CHECK, ok ? VerificationVerdict.PASS : VerificationVerdict.FAIL, { statistic: peak, samplesCanary: burn.length }, ok
						? undefined
						: { code: "verification-error-budget-exhausted", message: `burn rate ${peak} > ${spec.maxErrorBudgetBurn}` }),
				);
			}
		}
	}

	const pending = [...decided.values()].some((value) => value === "pending");
	if (!clock.windowEnded || pending) {
		return { complete: false, verdict: VerificationVerdict.UNSPECIFIED, checks: [], reasons: [] };
	}
	const checks = [...decided.values()].filter((value): value is CheckOutcomeRecord => value !== "pending");
	const failed = checks.some((check) => check.verdict === VerificationVerdict.FAIL);
	const inconclusive = checks.some((check) => check.verdict === VerificationVerdict.INCONCLUSIVE);
	const verdict = failed ? VerificationVerdict.FAIL : inconclusive ? VerificationVerdict.INCONCLUSIVE : VerificationVerdict.PASS;
	const reasons = checks.flatMap((check) => (check.reason ? [check.reason] : []));
	if (verdict === VerificationVerdict.INCONCLUSIVE && clock.deadlinePassed) {
		reasons.push(reason("verification-deadline-exceeded", "the progress deadline passed before every check had evidence"));
	}
	return { complete: true, verdict, checks, reasons };
}

/**
 * The only verdict that qualifies Freight or advances a stage. INCONCLUSIVE
 * and FAIL both stop the rollout (D9, I5).
 */
export function qualifies(verdict: VerificationVerdict): boolean {
	return verdict === VerificationVerdict.PASS;
}
