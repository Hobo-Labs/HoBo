// Golden vectors for the D9 Mann–Whitney U test. Every expected value was
// produced by scipy 1.18.1 `mannwhitneyu(canary, baseline, alternative=
// "two-sided")` (method "exact" for the no-tie n<8 rows, "asymptotic" with
// tie and continuity correction for the rest) and is pinned here, so a change
// in the implementation shows up as a diff against an independent reference.
import { describe, expect, it } from "vitest";
import {
	alphaFor,
	compareCohorts,
	mannWhitneyU,
	normalSurvival,
} from "../../src/verification/stats.js";
import { Direction, Sensitivity } from "../../src/_generated/cd_pb.js";

type Golden = Readonly<{
	name: string;
	canary: readonly number[];
	baseline: readonly number[];
	u: number;
	p: number;
	method: "exact" | "asymptotic";
}>;

const range = (n: number, step = 1, offset = 0) =>
	Array.from({ length: n }, (_, i) => i * step + offset);

const GOLDEN: readonly Golden[] = [
	{
		name: "exact, small, no ties, fully separated",
		canary: [1.1, 2.2, 3.3, 4.4, 5.5],
		baseline: [6.6, 7.7, 8.8, 9.9, 10.1, 11.2],
		u: 0,
		p: 0.004329004329004329,
		method: "exact",
	},
	{
		name: "exact, n<8, overlapping",
		canary: [3, 7, 1, 9, 4],
		baseline: [2, 8, 5, 6, 10, 11, 12],
		u: 9,
		p: 0.20202020202020204,
		method: "exact",
	},
	{
		name: "exact, a single canary sample (p clamps to 1)",
		canary: [5.5],
		baseline: [1, 2, 3, 4, 6, 7, 8, 9],
		u: 4,
		p: 1,
		method: "exact",
	},
	{
		name: "exact, n=7 against 30 baseline samples",
		canary: [10.5, 11.5, 12.5, 13.5, 14.5, 15.5, 16.5],
		baseline: range(30),
		u: 98,
		p: 0.805329954760695,
		method: "exact",
	},
	{
		name: "asymptotic with ties",
		canary: [1, 2, 2, 3, 3, 3, 4, 4, 5, 5],
		baseline: [3, 4, 4, 5, 5, 6, 6, 7, 7, 8],
		u: 13.5,
		p: 0.005855831149792345,
		method: "asymptotic",
	},
	{
		name: "asymptotic with heavy ties (binary series)",
		canary: [0, 0, 0, 0, 1, 0, 0, 0, 1, 0],
		baseline: [1, 1, 0, 1, 1, 1, 0, 1, 1, 1],
		u: 20,
		p: 0.010118581997593598,
		method: "asymptotic",
	},
	{
		name: "asymptotic, no ties, larger samples",
		canary: range(20, 0.1),
		baseline: range(25, 0.1, 0.55),
		u: 105,
		p: 0.000964739954959277,
		method: "asymptotic",
	},
	{
		name: "ties below n=8 fall back to the tie-corrected normal approximation",
		canary: [1, 1, 2, 3],
		baseline: [1, 2, 2, 3, 4],
		u: 6.5,
		p: 0.4448330086365213,
		method: "asymptotic",
	},
	{
		name: "n=8 in both cohorts is asymptotic (exact only below 8)",
		canary: [1, 2, 3, 4, 5, 6, 7, 8.5],
		baseline: [8, 9, 10, 11, 12, 13, 14, 15],
		u: 1,
		p: 0.0013593755271592322,
		method: "asymptotic",
	},
];

describe("Mann–Whitney U golden vectors (D9)", () => {
	for (const golden of GOLDEN) {
		it(golden.name, () => {
			const result = mannWhitneyU(golden.canary, golden.baseline);
			expect(result.u).toBe(golden.u);
			expect(result.method).toBe(golden.method);
			expect(result.p).toBeCloseTo(golden.p, 12);
		});
	}

	it("all samples identical: no evidence of a difference (p = 1)", () => {
		const result = mannWhitneyU([5, 5, 5, 5, 5, 5, 5, 5], [5, 5, 5, 5, 5, 5, 5, 5]);
		expect(result.u).toBe(32);
		expect(result.p).toBe(1);
	});

	it("is independent of input order (deterministic)", () => {
		const a = mannWhitneyU([3, 1, 2, 9, 4, 4], [8, 5, 6, 7, 4, 10, 11, 12]);
		const b = mannWhitneyU([4, 9, 2, 1, 3, 4], [12, 11, 10, 4, 7, 6, 5, 8]);
		expect(b).toEqual(a);
	});

	it("rejects empty or non-finite samples instead of guessing", () => {
		expect(() => mannWhitneyU([], [1, 2])).toThrow(/at least one/);
		expect(() => mannWhitneyU([1, Number.NaN], [1, 2])).toThrow(/finite/);
	});
});

describe("normal survival function", () => {
	it("matches reference values to 1e-12", () => {
		// scipy.stats.norm.sf
		expect(normalSurvival(0)).toBeCloseTo(0.5, 14);
		expect(normalSurvival(1.959963984540054)).toBeCloseTo(0.025, 12);
		expect(normalSurvival(3)).toBeCloseTo(0.0013498980316301035, 14);
		expect(normalSurvival(-1)).toBeCloseTo(0.8413447460685429, 12);
		expect(normalSurvival(6)).toBeCloseTo(9.865876450376946e-10, 18);
	});
});

describe("sensitivity maps to alpha (D9)", () => {
	it("LOW 0.01, MEDIUM 0.05, HIGH 0.10; unspecified is the MEDIUM default", () => {
		expect(alphaFor(Sensitivity.LOW)).toBe(0.01);
		expect(alphaFor(Sensitivity.MEDIUM)).toBe(0.05);
		expect(alphaFor(Sensitivity.HIGH)).toBe(0.1);
		expect(alphaFor(Sensitivity.UNSPECIFIED)).toBe(0.05);
	});
});

describe("canary-vs-baseline comparison fails only in the worse direction", () => {
	const better = [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9];
	const baseline = [5, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9];
	const worse = [9, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9];

	it("canary significantly worse (higher is worse) fails", () => {
		const outcome = compareCohorts({
			canary: worse,
			baseline,
			direction: Direction.HIGHER_IS_WORSE,
			sensitivity: Sensitivity.MEDIUM,
		});
		expect(outcome.significant).toBe(true);
		expect(outcome.worse).toBe(true);
		expect(outcome.failed).toBe(true);
	});

	it("canary significantly better (higher is worse) passes", () => {
		const outcome = compareCohorts({
			canary: better,
			baseline,
			direction: Direction.HIGHER_IS_WORSE,
			sensitivity: Sensitivity.MEDIUM,
		});
		expect(outcome.significant).toBe(true);
		expect(outcome.worse).toBe(false);
		expect(outcome.failed).toBe(false);
	});

	it("lower-is-worse inverts the direction", () => {
		const outcome = compareCohorts({
			canary: better,
			baseline,
			direction: Direction.LOWER_IS_WORSE,
			sensitivity: Sensitivity.MEDIUM,
		});
		expect(outcome.failed).toBe(true);
	});

	it("a difference not significant at the chosen alpha passes", () => {
		// p ≈ 0.0059 for the tie vector: significant at HIGH/MEDIUM, not at LOW.
		const canary = [3, 4, 4, 5, 5, 6, 6, 7, 7, 8];
		const base = [1, 2, 2, 3, 3, 3, 4, 4, 5, 5];
		const low = compareCohorts({
			canary,
			baseline: base,
			direction: Direction.HIGHER_IS_WORSE,
			sensitivity: Sensitivity.LOW,
		});
		const medium = compareCohorts({
			canary,
			baseline: base,
			direction: Direction.HIGHER_IS_WORSE,
			sensitivity: Sensitivity.MEDIUM,
		});
		expect(low.failed).toBe(true); // 0.0059 < 0.01
		expect(medium.failed).toBe(true);
		const subtle = compareCohorts({
			canary: [1, 1, 2, 3],
			baseline: [1, 2, 2, 3, 4],
			direction: Direction.LOWER_IS_WORSE,
			sensitivity: Sensitivity.HIGH,
		});
		expect(subtle.failed).toBe(false);
	});

	it("an unspecified direction is refused (no silent default)", () => {
		expect(() =>
			compareCohorts({
				canary: worse,
				baseline,
				direction: Direction.UNSPECIFIED,
				sensitivity: Sensitivity.MEDIUM,
			}),
		).toThrow(/direction/);
	});
});
