/**
 * The growth measure every redaction test leans on: it passes linear work,
 * fails quadratic work, and stops a run that has hung rather than waiting on
 * it. The verdicts are ratios, so they hold on a slow or loaded machine; the
 * hang backstop is checked with a stubbed clock, not by waiting 20 s.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	assertGrowsLinearly,
	grewLinearly,
	HANG_BACKSTOP_MS,
	LINEAR_GROWTH_LIMIT,
	MAX_REPEAT,
	MissingCpuClockError,
	measureGrowth,
	NEGATIVE_CONTROL,
	NonLinearGrowthError,
	OperationHangError,
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

// A growth measurement's backstop against the root config's 10 s timeout.
const GROWTH_TIMEOUT_MS = 30_000;

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

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

	it("refuses to measure without a per-thread CPU clock", () => {
		vi.stubGlobal("process", { threadCpuUsage: undefined });
		expect(() => measureGrowth(linearScan, repeatedTo("a"))).toThrow(
			MissingCpuClockError,
		);
	});

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

	it("passes an uncalibrated operation only while 4n stays cheap", () => {
		const uncalibrated = {
			length: 262_144,
			repeat: MAX_REPEAT,
			calibrated: false,
			smallMs: 0,
			largeMs: 4,
			ratio: 4000,
		};
		expect(grewLinearly(uncalibrated)).toBe(true);
		expect(grewLinearly({ ...uncalibrated, largeMs: 400 })).toBe(false);
		expect(grewLinearly({ ...uncalibrated, calibrated: true })).toBe(false);
	});

	it("stops at the first run past the backstop", () => {
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			now += HANG_BACKSTOP_MS + 1;
			return now;
		});
		const run = vi.fn();
		expect(() => measureGrowth(run, repeatedTo("a"))).toThrow(
			OperationHangError,
		);
		expect(run).toHaveBeenCalledTimes(1);
	});
});

describe("repeatedTo", () => {
	it("builds a text of at least the asked length, after its prefix", () => {
		const text = repeatedTo("ab", "x")(10);
		expect(text.startsWith("xab")).toBe(true);
		expect(text.length).toBeGreaterThanOrEqual(10);
		expect(text.length).toBeLessThan(12);
	});
});
