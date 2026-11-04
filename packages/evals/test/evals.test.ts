import type {
	CanMigrateGateVerdict,
	ResidencyGateVerdict,
} from "@hobo/contracts";
import { describe, expect, it } from "vitest";

import {
	asGateDimension,
	canonicalJson,
	defineRubric,
	EVALS_PROMOTION_VERDICT_SCHEMA,
	EVALS_RUBRIC_REPORT_SCHEMA,
	EVALS_RUBRIC_SCHEMA,
	evaluatePromotionGate,
	matchGolden,
	ObservationParseError,
	PromotionGateParseError,
	type PromotionGateVerdict,
	type Rubric,
	RubricParseError,
	type RubricReport,
	scoreRubric,
} from "../src/index.js";

function sampleRubric(): Rubric {
	return defineRubric({
		id: "rubric://support/classifier@1.0.0",
		passThreshold: 0.75,
		criteria: [
			{ id: "category-correct", weight: 3, kind: "scale", passThreshold: 0.9 },
			{ id: "pii-safe", weight: 1, kind: "boolean", required: true },
			{
				id: "golden-answer",
				weight: 4,
				kind: "golden-match",
				expected: { label: "billing", urgency: "high" },
			},
		],
	});
}

function passingObservations() {
	return [
		{ criterionId: "category-correct", score: 0.95 },
		{ criterionId: "pii-safe", passed: true },
		{
			criterionId: "golden-answer",
			actual: { urgency: "high", label: "billing" },
		},
	];
}

type CircularRecord = { label: string; self?: CircularRecord };
interface ReportPair {
	passing: RubricReport;
	failing: RubricReport;
}

describe("defineRubric", () => {
	it("parses a definition into a frozen schema-versioned record", () => {
		const rubric = sampleRubric();
		expect(rubric.schema).toBe(EVALS_RUBRIC_SCHEMA);
		expect(Object.isFrozen(rubric)).toBe(true);
		expect(Object.isFrozen(rubric.criteria)).toBe(true);
		expect(Object.isFrozen(rubric.criteria[0])).toBe(true);
		expect(rubric.criteria.map((criterion) => criterion.passThreshold)).toEqual(
			[0.9, 1, 1],
		);
		expect(rubric.criteria[1]?.required).toBe(true);
		expect(rubric.criteria[2]?.required).toBe(false);
	});

	it("rejects malformed definitions with typed RubricParseError", () => {
		const base = {
			id: "r",
			passThreshold: 0.5,
			criteria: [{ id: "c", weight: 1, kind: "boolean" as const }],
		};
		const bad = [
			// SAFETY: this deliberate invalid input exercises the parser boundary.
			undefined as never,
			{ ...base, id: "" },
			{ ...base, passThreshold: 1.2 },
			{ ...base, passThreshold: Number.NaN },
			{ ...base, criteria: [] },
			{ ...base, criteria: [{ ...base.criteria[0], id: "" }] },
			{ ...base, criteria: [{ ...base.criteria[0], weight: 0 }] },
			{ ...base, criteria: [{ ...base.criteria[0], weight: -1 }] },
			{
				...base,
				criteria: [{ ...base.criteria[0], weight: Number.POSITIVE_INFINITY }],
			},
			{
				...base,
				criteria: [
					{
						...base.criteria[0],
						// SAFETY: this deliberate invalid input exercises the parser boundary.
						kind: "vibes" as never,
					},
				],
			},
			{ ...base, criteria: [base.criteria[0], base.criteria[0]] },
			// scale must declare its own threshold; boolean must not.
			{ ...base, criteria: [{ id: "s", weight: 1, kind: "scale" as const }] },
			{
				...base,
				criteria: [
					{ id: "s", weight: 1, kind: "scale" as const, passThreshold: 2 },
				],
			},
			{
				...base,
				criteria: [{ ...base.criteria[0], passThreshold: 0.5 }],
			},
			// golden-match must bless an expected value.
			{
				...base,
				criteria: [{ id: "g", weight: 1, kind: "golden-match" as const }],
			},
			{ ...base, criteria: [{ ...base.criteria[0], expected: 1 }] },
		];
		for (const definition of bad) {
			// SAFETY: each case is intentionally malformed for parser coverage.
			expect(() => defineRubric(definition as never)).toThrow(RubricParseError);
		}
	});
});

describe("scoreRubric", () => {
	it("scores deterministically: identical inputs, identical frozen reports", () => {
		const rubric = sampleRubric();
		const first = scoreRubric(rubric, passingObservations());
		const second = scoreRubric(rubric, passingObservations());
		expect(second).toEqual(first);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.scores)).toBe(true);
		expect(Object.isFrozen(first.scores[0])).toBe(true);
		// Observation order does not matter.
		expect(scoreRubric(rubric, passingObservations().reverse())).toEqual(first);
	});

	it("computes the weight-normalized total", () => {
		const rubric = defineRubric({
			id: "weights",
			passThreshold: 0.5,
			criteria: [
				{ id: "a", weight: 1, kind: "boolean" },
				{ id: "b", weight: 3, kind: "boolean" },
			],
		});
		const report = scoreRubric(rubric, [
			{ criterionId: "a", passed: true },
			{ criterionId: "b", passed: false },
		]);
		// (1*1 + 3*0) / 4
		expect(report.weightedTotal).toBe(0.25);
		expect(report.ok).toBe(false);
		expect(report.failures.map((failure) => failure.code)).toEqual([
			"criterion.below-threshold",
			"rubric.total-below-threshold",
		]);
	});

	it("treats thresholds as inclusive floors, at criterion and rubric level", () => {
		const rubric = defineRubric({
			id: "edges",
			passThreshold: 0.6,
			criteria: [{ id: "s", weight: 1, kind: "scale", passThreshold: 0.6 }],
		});
		const atEdge = scoreRubric(rubric, [{ criterionId: "s", score: 0.6 }]);
		expect(atEdge.scores[0]?.passed).toBe(true);
		expect(atEdge.weightedTotal).toBe(0.6);
		expect(atEdge.ok).toBe(true);
		expect(atEdge.failures).toEqual([]);

		const below = scoreRubric(rubric, [{ criterionId: "s", score: 0.59 }]);
		expect(below.scores[0]?.passed).toBe(false);
		expect(below.ok).toBe(false);
	});

	it("accepts boundary scale scores 0 and 1 and rejects out-of-range ones", () => {
		const rubric = defineRubric({
			id: "bounds",
			passThreshold: 0,
			criteria: [{ id: "s", weight: 1, kind: "scale", passThreshold: 0 }],
		});
		expect(
			scoreRubric(rubric, [{ criterionId: "s", score: 0 }]).weightedTotal,
		).toBe(0);
		expect(
			scoreRubric(rubric, [{ criterionId: "s", score: 1 }]).weightedTotal,
		).toBe(1);
		for (const score of [-0.01, 1.01, Number.NaN]) {
			expect(() => scoreRubric(rubric, [{ criterionId: "s", score }])).toThrow(
				ObservationParseError,
			);
		}
	});

	it("fails the rubric when a required criterion fails, even above the total floor", () => {
		const rubric = defineRubric({
			id: "required",
			passThreshold: 0.5,
			criteria: [
				{ id: "quality", weight: 9, kind: "boolean" },
				{ id: "pii-safe", weight: 1, kind: "boolean", required: true },
			],
		});
		const report = scoreRubric(rubric, [
			{ criterionId: "quality", passed: true },
			{ criterionId: "pii-safe", passed: false },
		]);
		expect(report.weightedTotal).toBe(0.9);
		expect(report.ok).toBe(false);
		expect(report.failures.map((failure) => failure.code)).toEqual([
			"criterion.required-failed",
		]);
	});

	it("golden-match passes on canonically equal values and diffs on mismatch", () => {
		const rubric = defineRubric({
			id: "golden",
			passThreshold: 1,
			criteria: [
				{
					id: "g",
					weight: 1,
					kind: "golden-match",
					expected: { a: [1, { b: 2, c: 3 }], d: null },
				},
			],
		});
		const pass = scoreRubric(rubric, [
			// Key order everywhere is irrelevant.
			{ criterionId: "g", actual: { d: null, a: [1, { c: 3, b: 2 }] } },
		]);
		expect(pass.ok).toBe(true);
		expect(pass.scores[0]?.diff).toBeUndefined();

		const fail = scoreRubric(rubric, [
			{ criterionId: "g", actual: { a: [1, { b: 2, c: 4 }], d: null } },
		]);
		expect(fail.ok).toBe(false);
		expect(fail.scores[0]?.score).toBe(0);
		expect(fail.scores[0]?.diff).toEqual({
			path: "$.a[1].c",
			expected: 3,
			actual: 4,
		});
	});

	it("rejects malformed observations with typed ObservationParseError", () => {
		const rubric = sampleRubric();
		const cases = [
			// missing observation for a criterion
			passingObservations().slice(0, 2),
			// unknown criterion
			[...passingObservations(), { criterionId: "nope", passed: true }],
			// duplicate observation
			[...passingObservations(), { criterionId: "pii-safe", passed: true }],
			// wrong field for the kind
			[
				{ criterionId: "category-correct", passed: true },
				{ criterionId: "pii-safe", passed: true },
				{ criterionId: "golden-answer", actual: {} },
			],
			[
				{ criterionId: "category-correct", score: 0.95 },
				{ criterionId: "pii-safe", score: 1 },
				{ criterionId: "golden-answer", actual: {} },
			],
			[
				{ criterionId: "category-correct", score: 0.95 },
				{ criterionId: "pii-safe", passed: true },
				{ criterionId: "golden-answer", score: 1 },
			],
			// nameless observation
			[...passingObservations().slice(0, 2), { passed: true }],
		];
		for (const observations of cases) {
			// SAFETY: these cases intentionally contain malformed observations.
			expect(() => scoreRubric(rubric, observations as never)).toThrow(
				ObservationParseError,
			);
		}
	});

	it("rejects rubrics that did not come from defineRubric", () => {
		expect(() =>
			// SAFETY: this deliberately bypasses the parsed Rubric boundary.
			scoreRubric({ id: "raw", passThreshold: 1, criteria: [] } as never, []),
		).toThrow(RubricParseError);
	});
});

describe("matchGolden / canonicalJson", () => {
	it("compares expected/actual pairs by canonical JSON", () => {
		expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
			canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }),
		);
		expect(matchGolden({ x: 1, y: 2 }, { y: 2, x: 1 })).toEqual({
			equal: true,
		});
		expect(matchGolden([1, 2], [1, 2, 3])).toEqual({
			equal: false,
			diff: { path: "$[2]", expected: undefined, actual: 3 },
		});
	});

	it("does not crash on circular or bigint values", () => {
		const left: CircularRecord = { label: "billing" };
		left.self = left;
		const right: CircularRecord = { label: "billing" };
		right.self = right;
		expect(() => canonicalJson(left)).not.toThrow();
		expect(canonicalJson(left)).toBe(canonicalJson(right));
		expect(canonicalJson(1n)).toBe("1n");
		expect(matchGolden(1n, 1n)).toEqual({ equal: true });
		expect(matchGolden(1n, 1).equal).toBe(false);
		expect(matchGolden(left, right)).toEqual({ equal: true });
		expect(matchGolden(Number.NaN, null).equal).toBe(false);
		expect(
			matchGolden(new Date("2020-01-01T00:00:00.000Z"), new Date("2021-01-01"))
				.equal,
		).toBe(false);
	});
});

describe("evaluatePromotionGate", () => {
	function reports(): ReportPair {
		const rubric = sampleRubric();
		const failingObservations = [
			{ criterionId: "category-correct", score: 0.2 },
			{ criterionId: "pii-safe", passed: false },
			{ criterionId: "golden-answer", actual: { label: "other" } },
		];
		return {
			passing: scoreRubric(rubric, passingObservations()),
			failing: scoreRubric(rubric, failingObservations),
		};
	}

	it("promotes a passing report with an empty, frozen reason list", () => {
		const verdict = evaluatePromotionGate({
			rubricReport: reports().passing,
		});
		expect(verdict).toEqual({ ok: true, reasons: [] });
		expect(Object.isFrozen(verdict)).toBe(true);
		expect(Object.isFrozen(verdict.reasons)).toBe(true);
	});

	it("refuses a failing report with machine-readable evals.* reasons", () => {
		const verdict = evaluatePromotionGate({ rubricReport: reports().failing });
		expect(verdict.ok).toBe(false);
		const codes = verdict.reasons.map((reason) => reason.code);
		expect(codes[0]).toBe("evals.rubric-failed");
		expect(codes).toContain("evals.criterion.required-failed");
		expect(codes).toContain("evals.criterion.below-threshold");
		expect(codes).toContain("evals.rubric.total-below-threshold");
		for (const reason of verdict.reasons) {
			expect(reason.code.startsWith("evals.")).toBe(true);
			expect(reason.message.length).toBeGreaterThan(0);
		}
	});

	it("applies an extra weighted-total floor, inclusive at the edge", () => {
		const { passing } = reports();
		const atEdge = evaluatePromotionGate({
			rubricReport: passing,
			thresholds: { minWeightedTotal: passing.weightedTotal },
		});
		expect(atEdge.ok).toBe(true);

		const above = evaluatePromotionGate({
			rubricReport: passing,
			thresholds: { minWeightedTotal: 1 },
		});
		expect(above.ok).toBe(false);
		expect(above.reasons.map((reason) => reason.code)).toEqual([
			"evals.total-below-threshold",
		]);
	});

	it("can waive the rubric pass requirement while keeping the floor", () => {
		const { failing } = reports();
		const waived = evaluatePromotionGate({
			rubricReport: failing,
			thresholds: { requireRubricPass: false, minWeightedTotal: 0.05 },
		});
		expect(waived.ok).toBe(true);
	});

	it("rejects malformed inputs with typed PromotionGateParseError", () => {
		const { passing } = reports();
		// SAFETY: undefined is deliberate malformed input for parser coverage.
		expect(() => evaluatePromotionGate(undefined as never)).toThrow(
			PromotionGateParseError,
		);
		expect(() =>
			// SAFETY: this deliberately bypasses the parsed report boundary.
			evaluatePromotionGate({ rubricReport: { ok: true } as never }),
		).toThrow(PromotionGateParseError);
		expect(() =>
			evaluatePromotionGate({
				rubricReport: passing,
				thresholds: { minWeightedTotal: 1.5 },
			}),
		).toThrow(PromotionGateParseError);
	});

	it("is structurally a Gatekeeper precomputed dimension", () => {
		const verdict: PromotionGateVerdict = evaluatePromotionGate({
			rubricReport: reports().failing,
		});
		// Type-level: assignable to the contracts verdict shapes without casts
		// (the tsc-enforced proof also lives in src/index.ts asGateDimension).
		const residency: ResidencyGateVerdict = verdict;
		const canMigrate: CanMigrateGateVerdict = verdict;
		expect(residency).toBe(verdict);
		expect(canMigrate).toBe(verdict);
		expect(asGateDimension(verdict)).toBe(verdict);
		expect(EVALS_PROMOTION_VERDICT_SCHEMA).toBe(
			"hobo.evals.promotion-verdict/v1",
		);
		expect(reports().passing.schema).toBe(EVALS_RUBRIC_REPORT_SCHEMA);
	});
});
