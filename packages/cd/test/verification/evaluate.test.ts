// The pure verdict function: every WP9 Accept bullet that does not need the
// journal is pinned here (the engine tests repeat them end to end).
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	Aggregation,
	Cohort,
	Comparator,
	type EvidenceObservationRecord,
	EvidenceObservationRecordSchema,
	VerificationVerdict,
} from "../../src/_generated/cd_pb.js";
import { aggregate, evaluateVerification, qualifies } from "../../src/verification/evaluate.js";
import { type ParsedVerificationSpec, parseVerificationSpec } from "../../src/verification/spec.js";
import { comparisonSpec, MINUTE, query, T0, thresholdSpec } from "./fakes.js";

function parsed(spec: ReturnType<typeof thresholdSpec>): ParsedVerificationSpec {
	const outcome = parseVerificationSpec(spec);
	if (!outcome.ok) throw new Error(outcome.reasons.map((r) => r.code).join());
	return outcome.value;
}

function evidence(signal: string, values: readonly number[], cohort = Cohort.ALL, healthy = true): EvidenceObservationRecord[] {
	return values.map((value) =>
		create(EvidenceObservationRecordSchema, { campId: "camp-a", signal, value, cohort, healthy, observedAt: new Date(T0).toISOString(), source: "test" }),
	);
}

const WINDOW_END = T0 + 10 * MINUTE;
const DEADLINE = T0 + 30 * MINUTE;
const BASELINE = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109];
const WORSE = [150, 151, 152, 153, 154, 155, 156, 157, 158, 159];
const BETTER = [50, 51, 52, 53, 54, 55, 56, 57, 58, 59];

describe("comparison verdicts (D9)", () => {
	const spec = parsed(comparisonSpec());
	const run = (canary: readonly number[]) =>
		evaluateVerification({
			spec,
			cohortAware: true,
			startedAtMs: T0,
			atMs: WINDOW_END,
			evidence: [...evidence("comparison:latency_ms", canary, Cohort.CANARY), ...evidence("comparison:latency_ms", BASELINE, Cohort.BASELINE)],
		});

	it("canary significantly worse → FAIL", () => {
		const result = run(WORSE);
		expect(result.complete).toBe(true);
		expect(result.verdict).toBe(VerificationVerdict.FAIL);
		expect(result.checks[0]?.reason?.code).toBe("verification-canary-worse");
		expect(result.checks[0]?.pValue).toBeLessThan(0.05);
		expect(result.checks[0]?.samplesCanary).toBe(10);
		expect(result.checks[0]?.samplesBaseline).toBe(10);
	});

	it("canary significantly better → PASS", () => {
		const result = run(BETTER);
		expect(result.verdict).toBe(VerificationVerdict.PASS);
		expect(result.checks[0]?.pValue).toBeLessThan(0.05);
	});

	it("a comparison without a baseline cohort fails closed", () => {
		const result = evaluateVerification({ spec, cohortAware: false, startedAtMs: T0, atMs: WINDOW_END, evidence: [] });
		expect(result.verdict).toBe(VerificationVerdict.FAIL);
		expect(result.checks[0]?.reason?.code).toBe("verification-cohort-unavailable");
	});
});

describe("no data → FAIL (I5)", () => {
	it("an empty window fails at window end, without waiting for the deadline", () => {
		const result = evaluateVerification({ spec: parsed(thresholdSpec()), cohortAware: false, startedAtMs: T0, atMs: WINDOW_END, evidence: [] });
		expect(result.complete).toBe(true);
		expect(result.verdict).toBe(VerificationVerdict.FAIL);
		expect(result.checks[0]?.reason?.code).toBe("verification-no-data");
	});

	it("an empty baseline is no data too", () => {
		const result = evaluateVerification({
			spec: parsed(comparisonSpec()),
			cohortAware: true,
			startedAtMs: T0,
			atMs: WINDOW_END,
			evidence: evidence("comparison:latency_ms", WORSE, Cohort.CANARY),
		});
		expect(result.verdict).toBe(VerificationVerdict.FAIL);
	});

	it("fail_on_no_data=false still never passes: INCONCLUSIVE", () => {
		const result = evaluateVerification({
			spec: parsed(thresholdSpec({ failOnNoData: false })),
			cohortAware: false,
			startedAtMs: T0,
			atMs: WINDOW_END,
			evidence: [],
		});
		expect(result.verdict).toBe(VerificationVerdict.INCONCLUSIVE);
		expect(qualifies(result.verdict)).toBe(false);
	});

	it("an unavailable source waits (retry) until the deadline, then is no data", () => {
		const spec = parsed(thresholdSpec());
		const unavailable = new Set(["threshold:error_rate"]);
		expect(evaluateVerification({ spec, cohortAware: false, startedAtMs: T0, atMs: WINDOW_END, evidence: [], unavailable }).complete).toBe(false);
		const late = evaluateVerification({ spec, cohortAware: false, startedAtMs: T0, atMs: DEADLINE, evidence: [], unavailable });
		expect(late.verdict).toBe(VerificationVerdict.FAIL);
		expect(late.checks[0]?.reason?.code).toBe("verification-no-data");
	});
});

describe("deadline → INCONCLUSIVE → treated as FAIL by rollout", () => {
	const spec = parsed(thresholdSpec());
	const partial = evidence("threshold:error_rate", [0.01, 0.02]);

	it("partial evidence before the deadline keeps the verification running", () => {
		expect(evaluateVerification({ spec, cohortAware: false, startedAtMs: T0, atMs: WINDOW_END, evidence: partial }).complete).toBe(false);
	});

	it("at the deadline it completes INCONCLUSIVE with the deadline reason, and does not qualify", () => {
		const result = evaluateVerification({ spec, cohortAware: false, startedAtMs: T0, atMs: DEADLINE, evidence: partial });
		expect(result.complete).toBe(true);
		expect(result.verdict).toBe(VerificationVerdict.INCONCLUSIVE);
		expect(result.checks[0]?.reason?.code).toBe("verification-insufficient-observations");
		expect(result.reasons.map((r) => r.code)).toContain("verification-deadline-exceeded");
		expect(qualifies(result.verdict)).toBe(false);
	});

	it("nothing completes before the window ends, even with full evidence", () => {
		const full = evidence("threshold:error_rate", [0.01, 0.01, 0.01]);
		expect(evaluateVerification({ spec, cohortAware: false, startedAtMs: T0, atMs: WINDOW_END - 1, evidence: full }).complete).toBe(false);
	});
});

describe("thresholds per aggregation", () => {
	const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
	it.each([
		[Aggregation.MEAN, 14.5],
		[Aggregation.P50, 5],
		[Aggregation.P95, 100],
		[Aggregation.P99, 100],
		[Aggregation.MAX, 100],
		[Aggregation.SUM, 145],
	])("aggregation %s", (aggregation, expected) => {
		expect(aggregate(values, aggregation)).toBe(expected);
	});

	it.each([
		[Comparator.LT, 0.25, VerificationVerdict.FAIL],
		[Comparator.LTE, 0.25, VerificationVerdict.PASS],
		[Comparator.GT, 0.25, VerificationVerdict.FAIL],
		[Comparator.GTE, 0.25, VerificationVerdict.PASS],
	])("comparator %s against the mean 0.25 (exact in binary)", (comparator, bound, verdict) => {
		const spec = parsed(
			thresholdSpec({ thresholds: [{ query: query("error_rate", { unit: "ratio" }), aggregation: Aggregation.MEAN, comparator, value: bound }] }),
		);
		const result = evaluateVerification({
			spec,
			cohortAware: false,
			startedAtMs: T0,
			atMs: WINDOW_END,
			evidence: evidence("threshold:error_rate", [0.25, 0.25, 0.25]),
		});
		expect(result.verdict).toBe(verdict);
	});

	it("a ratio sample outside [0, 1] is an invalid sample, not a pass (slo-as-code: good > total fails closed)", () => {
		const result = evaluateVerification({
			spec: parsed(thresholdSpec()),
			cohortAware: false,
			startedAtMs: T0,
			atMs: WINDOW_END,
			evidence: evidence("threshold:error_rate", [0.01, 1.4, 0.01]),
		});
		expect(result.verdict).toBe(VerificationVerdict.FAIL);
		expect(result.checks[0]?.reason?.code).toBe("verification-invalid-sample");
	});

	it("thresholds read the canary cohort when traffic is split", () => {
		const result = evaluateVerification({
			spec: parsed(thresholdSpec()),
			cohortAware: true,
			startedAtMs: T0,
			atMs: WINDOW_END,
			evidence: [...evidence("threshold:error_rate", [0.9, 0.9, 0.9], Cohort.CANARY), ...evidence("threshold:error_rate", [0, 0, 0], Cohort.ALL)],
		});
		expect(result.verdict).toBe(VerificationVerdict.FAIL);
	});
});

describe("probes and suites", () => {
	const spec = parsed(
		thresholdSpec({
			thresholds: [],
			probes: [{ name: "health", urlRef: "https://api.example.com/healthz", minSuccessRatio: 0.75 }],
			suites: [{ suite: "smoke" }],
		}),
	);
	it("probe ratio at or above min_success_ratio passes; a failed suite fails", () => {
		const probe = [...evidence("probe:health", [200, 200, 200]), ...evidence("probe:health", [503], Cohort.ALL, false)];
		const passing = evaluateVerification({ spec, cohortAware: false, startedAtMs: T0, atMs: WINDOW_END, evidence: [...probe, ...evidence("suite:smoke", [1])] });
		expect(passing.verdict).toBe(VerificationVerdict.PASS);
		const suiteFailed = evaluateVerification({
			spec,
			cohortAware: false,
			startedAtMs: T0,
			atMs: WINDOW_END,
			evidence: [...probe, ...evidence("suite:smoke", [0], Cohort.ALL, false)],
		});
		expect(suiteFailed.verdict).toBe(VerificationVerdict.FAIL);
		expect(suiteFailed.checks.find((c) => c.check === "suite:smoke")?.reason?.code).toBe("verification-suite-failed");
	});

	it("probe ratio below the minimum fails", () => {
		const probe = [...evidence("probe:health", [200, 200]), ...evidence("probe:health", [503, 503], Cohort.ALL, false)];
		const result = evaluateVerification({ spec, cohortAware: false, startedAtMs: T0, atMs: WINDOW_END, evidence: [...probe, ...evidence("suite:smoke", [1])] });
		expect(result.checks.find((c) => c.check === "probe:health")?.reason?.code).toBe("verification-probe-failed");
	});

	it("a suite that never reported waits, then is no data at the deadline", () => {
		const probe = evidence("probe:health", [200, 200, 200]);
		expect(evaluateVerification({ spec, cohortAware: false, startedAtMs: T0, atMs: WINDOW_END, evidence: probe }).complete).toBe(false);
		const late = evaluateVerification({ spec, cohortAware: false, startedAtMs: T0, atMs: DEADLINE, evidence: probe });
		expect(late.verdict).toBe(VerificationVerdict.FAIL);
	});
});
