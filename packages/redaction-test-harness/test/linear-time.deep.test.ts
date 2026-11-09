/**
 * The deep tier of the growth measure and the sweep (`pnpm run test:deep`):
 * real measurements, which take a second or so of CPU each. The verdicts are
 * ratios, so they hold on a slow or loaded machine.
 */
import { describe, expect, it } from "vitest";

import {
	assertSweepLinear,
	SWEEP_LENGTH,
	SWEEP_SCREEN_RATIO,
	SweepGrowthError,
	screenRatio,
	sweepInputs,
} from "../src/linear-sweep.js";
import {
	assertGrowsLinearly,
	grewLinearly,
	LINEAR_GROWTH_LIMIT,
	MAX_REPEAT,
	measureGrowth,
	NEGATIVE_CONTROL,
	NonLinearGrowthError,
	repeatedTo,
} from "../src/linear-time.js";

// Linear work: read every character once.
function linearScan(text: string): void {
	let sum = 0;
	for (let index = 0; index < text.length; index++)
		sum += text.charCodeAt(index);
	if (sum < 0) throw new Error("unreachable");
}

// Quadratic work: from every position, read to the end.
function quadraticScan(text: string): void {
	let sum = 0;
	for (let from = 0; from < text.length; from++)
		for (let index = from; index < text.length; index++)
			sum += text.charCodeAt(index);
	if (sum < 0) throw new Error("unreachable");
}

const GROWTH_TIMEOUT_MS = 600_000;

describe("measureGrowth", () => {
	it("passes linear work and reports the sizes it measured", {
		timeout: GROWTH_TIMEOUT_MS,
	}, () => {
		const growth = measureGrowth(linearScan, repeatedTo("a"));
		expect(grewLinearly(growth), JSON.stringify(growth)).toBe(true);
		expect(growth.length).toBeGreaterThanOrEqual(4096);
		expect(growth.ratio).toBe(growth.largeMs / Math.max(growth.smallMs, 0.001));
	});

	it(
		"fails quadratic work, at a size quadratic work still finishes at",
		() => {
			// Measured once, with the cheap negative-control options.
			let refused: unknown;
			try {
				assertGrowsLinearly(quadraticScan, repeatedTo("a"), NEGATIVE_CONTROL);
			} catch (error) {
				refused = error;
			}
			if (!(refused instanceof NonLinearGrowthError))
				throw new Error(
					`expected a NonLinearGrowthError, got ${String(refused)}`,
				);
			expect(refused.growth.ratio).toBeGreaterThanOrEqual(LINEAR_GROWTH_LIMIT);
			expect(grewLinearly(refused.growth)).toBe(false);
			expect(refused.growth.length).toBeLessThanOrEqual(
				NEGATIVE_CONTROL.maxLength ?? 0,
			);
		},
		GROWTH_TIMEOUT_MS,
	);

	it("repeats an operation too quick to time, and keeps its ratio honest", {
		timeout: GROWTH_TIMEOUT_MS,
	}, () => {
		const constant = measureGrowth((text) => {
			text.charCodeAt(0);
		}, repeatedTo("a"));
		expect(constant.repeat).toBe(MAX_REPEAT);
		expect(grewLinearly(constant), JSON.stringify(constant)).toBe(true);
		const fast = measureGrowth(linearScan, repeatedTo("a"));
		expect(grewLinearly(fast), JSON.stringify(fast)).toBe(true);
	});
});

describe("the sweep", () => {
	it(
		"finds a class nobody built an input from",
		() => {
			// Quadratic on runs of `_` (and only of `_` among the sweep's
			// classes): every start reads the run to its end and finds no `!`.
			const underscoreRuns = /_+!/gu;
			let refused: unknown;
			try {
				assertSweepLinear(
					(text) => {
						text.replace(underscoreRuns, "");
					},
					{ alphabet: "z" },
					{ failFast: true },
				);
			} catch (error) {
				refused = error;
			}
			if (!(refused instanceof SweepGrowthError))
				throw new Error(`expected a SweepGrowthError, got ${String(refused)}`);
			// Which input is reported first is the sweep's order, not the
			// pattern's, so the test holds what it is, not what it is called: a
			// long run of `_` with no `!` in it.
			const [offender] = refused.offenders;
			const reported = sweepInputs({ alphabet: "z" }).find(
				(input) => input.name === offender?.input,
			);
			const text = reported?.text(1024) ?? "";
			expect(refused.offenders).toHaveLength(1);
			expect(text).toMatch(/_{256}/u);
			expect(text).not.toContain("!");
		},
		GROWTH_TIMEOUT_MS,
	);

	it("screens a quadratic call far above the ratio and a linear one below it", () => {
		// The threshold's margin, measured: a linear redaction costs a few
		// reference scans, and a quadratic one hundreds at SWEEP_LENGTH.
		const runs = "_".repeat(SWEEP_LENGTH);
		const quadratic = (text: string): void => {
			text.replace(/_+!/gu, "");
		};
		const linear = (text: string): void => {
			text.replace(/_+/gu, "");
		};
		const best = (run: (text: string) => void) =>
			Math.min(...[0, 1, 2, 3, 4].map(() => screenRatio(run, runs)));
		expect(best(quadratic)).toBeGreaterThan(4 * SWEEP_SCREEN_RATIO);
		expect(best(linear)).toBeLessThan(SWEEP_SCREEN_RATIO / 2);
	});
});
