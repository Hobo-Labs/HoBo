/**
 * The growth measure every redaction test leans on: it passes linear work,
 * fails quadratic work, and stops a run that has hung rather than waiting on
 * it. The verdicts are ratios, so they hold on a slow or loaded machine; the
 * hang backstop is checked with a stubbed clock, not by waiting 20 s.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	assertSweepLinear,
	patternFragments,
	SEPARATOR_CLASSES,
	SWEEP_LENGTH,
	SWEEP_SCREEN_RATIO,
	SweepGrowthError,
	screenRatio,
	sweepInputs,
} from "../src/linear-sweep.js";
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

	it("calls an operation calibrated by its calibrating run, not its best", () => {
		// Quadratic: 12 ms of CPU at n, 192 ms at 4n, but the calibrating run at
		// n was slowed to 25 ms. Read from the best run at n (12 ms, under
		// minMs) it looked like an operation that costs next to nothing, and
		// 4n under 8 × minMs passed it as linear.
		let cpu = 0;
		vi.spyOn(process, "threadCpuUsage").mockImplementation(() => ({
			user: cpu * 1000,
			system: 0,
		}));
		let calls = 0;
		const quadratic = (text: string): void => {
			calls++;
			cpu += calls === 1 ? 25 : 12 * (text.length / 4096) ** 2;
		};
		const growth = measureGrowth(quadratic, repeatedTo("a"), {
			startLength: 4096,
			maxLength: 4096,
			minMs: 20,
		});
		expect(growth).toMatchObject({ calibrated: true, smallMs: 12 });
		expect(growth.ratio).toBeCloseTo(16);
		expect(grewLinearly(growth)).toBe(false);
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

	it("builds every class, every pair, and each word followed by each class", () => {
		const inputs = sweepInputs({ alphabet: "a", words: ["w"] });
		const classes = new Set(["a", ...SEPARATOR_CLASSES]).size;
		const separators = SEPARATOR_CLASSES.length;
		// Runs and pairs; around a piece ("" or "w" before, "w" after); ended by
		// each terminator but the run's own; then a terminator and "w"; and the
		// word on its own, before each class, and with each class.
		const pairs = classes + classes * (classes - 1);
		const around = 2 * classes;
		const ended = 2 * (classes * separators - separators);
		const thenWord = 2 * separators;
		expect(inputs).toHaveLength(
			pairs + around + ended + thenWord + 1 + 2 * classes,
		);
		expect(inputs.map((input) => input.name)).toContain('"_ " repeated');
	});

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

	it("puts a run between a pattern's fragments, and a terminator before one", () => {
		const key = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
		const names = sweepInputs({
			alphabet: "a",
			words: [key],
			fragments: ["-----END"],
		}).map((input) => input.name);
		expect(names).toContain(
			`${JSON.stringify(key)}, "a" repeated, then " -----END"`,
		);
		expect(names).toContain('"-----END", "a" repeated, "-----END"');
	});

	it("reads a pattern's literal fragments from its source", () => {
		expect(
			patternFragments(/-----BEGIN[^-]*PRIVATE KEY-----(?:x|y)-----END/u),
		).toEqual(["-----BEGIN", "PRIVATE KEY-----", "-----END"]);
		// A quantified character is not part of the run before it, and `=`, `:`
		// and `://` are kept.
		expect(patternFragments(/rediss?:\/\/\S+/u)).toEqual(["redis", "://", ":"]);
		expect(patternFragments(/\bBearer\s+\S+/u)).toEqual(["Bearer"]);
		expect(patternFragments(/(?<![a-z])api_key=\S+/u)).toEqual([
			"api_key=",
			"=",
		]);
	});

	it("names an input a call hangs on, as an offender", () => {
		const hang = (text: string): void => {
			if (text.startsWith("x"))
				throw new OperationHangError(text.length, 25_000);
		};
		let caught: unknown;
		try {
			assertSweepLinear(hang, { alphabet: "x" }, { length: 1024 });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(SweepGrowthError);
		expect(String(caught)).toContain('"x" repeated (one call ran 25000 ms)');
	});
});
