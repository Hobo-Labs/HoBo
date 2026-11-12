// D9 statistics: the two-sided Mann–Whitney U test that compares a canary
// cohort with its baseline. Pure, deterministic, dependency-free.
//
// - Exact null distribution when the smaller cohort has fewer than 8 samples
//   and there are no ties (the "exact table"; computed, not looked up, as the
//   coefficients of the Gaussian binomial [m+n choose m]_q in BigInt).
// - Otherwise the normal approximation with tie correction and continuity
//   correction.
//
// Both match scipy's `mannwhitneyu(x, y, alternative="two-sided")`, which the
// golden vectors in test/verification/stats.test.ts pin.
import { Direction, Sensitivity } from "../_generated/cd_pb.js";

export type MannWhitneyResult = Readonly<{
	/** U for the canary (first) sample: pairs where canary > baseline, ties count ½. */
	u: number;
	/** Two-sided p-value in [0, 1]. */
	p: number;
	method: "exact" | "asymptotic";
	nCanary: number;
	nBaseline: number;
}>;

/** Below this many samples in the smaller cohort (and with no ties) the exact distribution is used. */
export const EXACT_BELOW = 8;

function midranks(
	values: readonly number[],
): Readonly<{ ranks: number[]; tieGroups: number[] }> {
	const order = values
		.map((value, index) => ({ value, index }))
		.sort((a, b) => a.value - b.value || a.index - b.index);
	const ranks = new Array<number>(values.length).fill(0);
	const tieGroups: number[] = [];
	let start = 0;
	while (start < order.length) {
		let end = start;
		while (
			end + 1 < order.length &&
			order[end + 1]?.value === order[start]?.value
		)
			end += 1;
		const rank = (start + end) / 2 + 1;
		for (let k = start; k <= end; k += 1) {
			const entry = order[k];
			if (entry) ranks[entry.index] = rank;
		}
		tieGroups.push(end - start + 1);
		start = end + 1;
	}
	return { ranks, tieGroups };
}

/**
 * Counts of each U value under the null for cohort sizes m and n: the
 * coefficients of prod_{i=1..m} (1 - q^(n+i)) / (1 - q^i). Every intermediate
 * product is itself a Gaussian binomial, so the coefficients stay exact
 * non-negative integers.
 */
function exactCounts(m: number, n: number): bigint[] {
	const degree = m * n;
	let coefficients: bigint[] = new Array<bigint>(degree + 1).fill(0n);
	coefficients[0] = 1n;
	for (let i = 1; i <= m; i += 1) {
		const next = coefficients.slice();
		const shift = n + i;
		for (let k = degree; k >= shift; k -= 1)
			next[k] = (next[k] ?? 0n) - (coefficients[k - shift] ?? 0n);
		for (let k = i; k <= degree; k += 1)
			next[k] = (next[k] ?? 0n) + (next[k - i] ?? 0n);
		coefficients = next;
	}
	return coefficients;
}

function exactTwoSided(u: number, m: number, n: number): number {
	const small = Math.min(m, n);
	const large = Math.max(m, n);
	const counts = exactCounts(small, large);
	const total = counts.reduce((sum, count) => sum + count, 0n);
	const upper = Math.max(u, m * n - u);
	let tail = 0n;
	for (let k = upper; k <= m * n; k += 1) tail += counts[k] ?? 0n;
	return Math.min(1, (2 * Number(tail)) / Number(total));
}

/**
 * Complementary error function, |relative error| < 1e-14: the Maclaurin series
 * for erf near zero and a Lentz continued fraction for erfc in the tail.
 */
function erfc(x: number): number {
	if (x < 0) return 2 - erfc(-x);
	if (x < 2) {
		// erf(x) = 2/sqrt(pi) * sum (-1)^k x^(2k+1) / (k! (2k+1))
		let term = x;
		let sum = x;
		for (let k = 1; k < 200; k += 1) {
			term *= (-x * x) / k;
			const delta = term / (2 * k + 1);
			sum += delta;
			if (Math.abs(delta) < 1e-17 * Math.abs(sum)) break;
		}
		return 1 - (2 / Math.sqrt(Math.PI)) * sum;
	}
	// erfc(x) = exp(-x^2)/sqrt(pi) * 1/(x + 1/2/(x + 1/(x + 3/2/(x + ...))))
	const tiny = 1e-300;
	let f = x;
	let c = x;
	let d = 0;
	for (let k = 1; k < 500; k += 1) {
		const a = k / 2;
		d = x + a * d;
		d = d === 0 ? tiny : d;
		c = x + a / c;
		c = c === 0 ? tiny : c;
		d = 1 / d;
		const delta = c * d;
		f *= delta;
		if (Math.abs(delta - 1) < 1e-16) break;
	}
	return Math.exp(-x * x) / Math.sqrt(Math.PI) / f;
}

/** Survival function of the standard normal distribution, P(Z > z). */
export function normalSurvival(z: number): number {
	return 0.5 * erfc(z / Math.SQRT2);
}

function assertSample(values: readonly number[], name: string): void {
	if (values.length === 0)
		throw new RangeError(`${name} needs at least one sample`);
	if (!values.every(Number.isFinite))
		throw new RangeError(`${name} samples must be finite numbers`);
}

/** Two-sided Mann–Whitney U test of canary against baseline. */
export function mannWhitneyU(
	canary: readonly number[],
	baseline: readonly number[],
): MannWhitneyResult {
	assertSample(canary, "canary");
	assertSample(baseline, "baseline");
	const m = canary.length;
	const n = baseline.length;
	const { ranks, tieGroups } = midranks([...canary, ...baseline]);
	let canaryRankSum = 0;
	for (let i = 0; i < m; i += 1) canaryRankSum += ranks[i] ?? 0;
	const u = canaryRankSum - (m * (m + 1)) / 2;
	const hasTies = tieGroups.some((size) => size > 1);
	if (!hasTies && Math.min(m, n) < EXACT_BELOW) {
		return {
			u,
			p: exactTwoSided(u, m, n),
			method: "exact",
			nCanary: m,
			nBaseline: n,
		};
	}
	const total = m + n;
	const tieTerm = tieGroups.reduce((sum, t) => sum + (t * t * t - t), 0);
	const variance =
		((m * n) / 12) * (total + 1 - tieTerm / (total * (total - 1)));
	if (!(variance > 0))
		return { u, p: 1, method: "asymptotic", nCanary: m, nBaseline: n };
	const z = (Math.max(u, m * n - u) - (m * n) / 2 - 0.5) / Math.sqrt(variance);
	return {
		u,
		p: Math.min(1, Math.max(0, 2 * normalSurvival(z))),
		method: "asymptotic",
		nCanary: m,
		nBaseline: n,
	};
}

/** D9: LOW 0.01, MEDIUM 0.05 (the default), HIGH 0.10. */
export function alphaFor(sensitivity: Sensitivity): number {
	switch (sensitivity) {
		case Sensitivity.LOW:
			return 0.01;
		case Sensitivity.HIGH:
			return 0.1;
		default:
			return 0.05;
	}
}

export type CohortComparison = MannWhitneyResult &
	Readonly<{
		alpha: number;
		/** p < alpha. */
		significant: boolean;
		/** The canary sits on the worse side of the baseline for this direction. */
		worse: boolean;
		/** Significant and worse: the only way a comparison fails (D9). */
		failed: boolean;
	}>;

export function compareCohorts(
	input: Readonly<{
		canary: readonly number[];
		baseline: readonly number[];
		direction: Direction;
		sensitivity: Sensitivity;
	}>,
): CohortComparison {
	if (
		input.direction !== Direction.HIGHER_IS_WORSE &&
		input.direction !== Direction.LOWER_IS_WORSE
	) {
		throw new RangeError(
			"comparison direction must be HIGHER_IS_WORSE or LOWER_IS_WORSE",
		);
	}
	const result = mannWhitneyU(input.canary, input.baseline);
	const alpha = alphaFor(input.sensitivity);
	const midpoint = (result.nCanary * result.nBaseline) / 2;
	const worse =
		input.direction === Direction.HIGHER_IS_WORSE
			? result.u > midpoint
			: result.u < midpoint;
	const significant = result.p < alpha;
	return { ...result, alpha, significant, worse, failed: significant && worse };
}
