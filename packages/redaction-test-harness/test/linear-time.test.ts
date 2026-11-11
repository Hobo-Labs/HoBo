/**
 * The growth measure every redaction test leans on: it passes linear work,
 * fails quadratic work, and stops a run that has hung rather than waiting on
 * it. The verdicts are ratios, so they hold on a slow or loaded machine; the
 * hang backstop is checked with a stubbed clock, not by waiting 20 s.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	assertInputLinear,
	assertSweepLinear,
	PERIODS,
	patternAlphabet,
	patternFragments,
	SEPARATOR_CLASSES,
	SweepGrowthError,
	sweepInputs,
} from "../src/linear-sweep.js";
import {
	assertGrowsLinearly,
	type Growth,
	grewLinearly,
	HANG_BACKSTOP_MS,
	logLogSlope,
	MAX_REPEAT,
	MissingCpuClockError,
	measureGrowth,
	medianCpuMs,
	minCpuMs,
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

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("measureGrowth", () => {
	it("refuses to measure without a per-thread CPU clock", () => {
		vi.stubGlobal("process", { threadCpuUsage: undefined });
		expect(() => measureGrowth(linearScan, repeatedTo("a"))).toThrow(
			MissingCpuClockError,
		);
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
		const uncalibratedGrowth: Growth = {
			...uncalibrated,
			points: [
				{ length: uncalibrated.length, minMs: uncalibrated.smallMs },
				{
					length: 4 * uncalibrated.length,
					minMs: uncalibrated.largeMs,
				},
			],
			logLogSlope: 2,
		};
		expect(grewLinearly(uncalibratedGrowth, 30)).toBe(true);
		expect(grewLinearly({ ...uncalibratedGrowth, largeMs: 400 }, 30)).toBe(
			false,
		);
		expect(grewLinearly({ ...uncalibratedGrowth, calibrated: true }, 30)).toBe(
			false,
		);
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
			maxLength: 16_384,
			minMs: 20,
			ladderSteps: 2,
		});
		expect(growth).toMatchObject({ calibrated: true, smallMs: 12 });
		expect(growth.ratio).toBeCloseTo(16);
		expect(grewLinearly(growth)).toBe(false);
	});

	it("uses the minimum of interleaved samples so one inflated CPU reading does not fail linear work", () => {
		let cpu = 0;
		let largeMeasures = 0;
		vi.spyOn(process, "threadCpuUsage").mockImplementation(() => ({
			user: cpu * 1000,
			system: 0,
		}));
		const smallCost = 40;
		const linear = (text: string): void => {
			if (text.length <= 4096) {
				cpu += smallCost;
				return;
			}
			const scale = text.length / 4096;
			largeMeasures += 1;
			// One doubled size at 2.25×; minimum samples keep doubling near 2×.
			cpu += largeMeasures === 3 ? smallCost * scale * 2.25 : smallCost * scale;
		};
		const growth = measureGrowth(linear, repeatedTo("a"), {
			startLength: 4096,
			maxLength: 16_384,
			minMs: 1,
			runs: 5,
			warmupRuns: 1,
			ladderSteps: 2,
		});
		expect(growth.ratio).toBeLessThan(8);
		expect(grewLinearly(growth, 1)).toBe(true);
		expect(growth.points.length).toBeGreaterThanOrEqual(3);
	});

	it("rejects deliberately quadratic work", () => {
		let cpu = 0;
		vi.spyOn(process, "threadCpuUsage").mockImplementation(() => ({
			user: cpu * 1000,
			system: 0,
		}));
		const quadratic = (text: string): void => {
			const units = text.length / 1024;
			cpu += units * units;
		};
		const growth = measureGrowth(quadratic, repeatedTo("a"), NEGATIVE_CONTROL);
		expect(grewLinearly(growth, NEGATIVE_CONTROL.minMs)).toBe(false);
		expect(growth.logLogSlope).toBeGreaterThan(1.6);
		expect(() =>
			assertGrowsLinearly(quadratic, repeatedTo("a"), NEGATIVE_CONTROL),
		).toThrow(NonLinearGrowthError);
	});

	it("passes linear work under noisy CPU even when one 4× ratio would exceed the cap", () => {
		let cpu = 0;
		let largeMeasures = 0;
		vi.spyOn(process, "threadCpuUsage").mockImplementation(() => ({
			user: cpu * 1000,
			system: 0,
		}));
		const base = 100;
		const linear = (text: string): void => {
			const scale = text.length / 4096;
			if (text.length <= 4096) {
				cpu += base;
				return;
			}
			largeMeasures += 1;
			cpu += largeMeasures === 2 ? base * scale * 2.2 : base * scale;
		};
		const growth = measureGrowth(linear, repeatedTo("a"), {
			startLength: 4096,
			maxLength: 16_384,
			minMs: 1,
			runs: 7,
			warmupRuns: 1,
			ladderSteps: 2,
		});
		expect(growth.ratio).toBeGreaterThanOrEqual(4);
		expect(grewLinearly(growth, 1)).toBe(true);
		expect(growth.logLogSlope).toBeLessThan(1.55);
	});

	it("medianCpuMs and minCpuMs summarize samples", () => {
		expect(medianCpuMs([10, 11, 12, 13, 90])).toBe(12);
		expect(minCpuMs([10, 11, 12, 13, 90])).toBe(10);
	});

	it("logLogSlope is about 1 for linear points and about 2 for quadratic", () => {
		expect(
			logLogSlope([
				{ length: 1000, minMs: 10 },
				{ length: 2000, minMs: 20 },
				{ length: 4000, minMs: 40 },
			]),
		).toBeCloseTo(1, 5);
		expect(
			logLogSlope([
				{ length: 1000, minMs: 1 },
				{ length: 2000, minMs: 4 },
				{ length: 4000, minMs: 16 },
			]),
		).toBeCloseTo(2, 5);
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
	it("builds every class, every pair, and each word followed by each class", () => {
		const inputs = sweepInputs({ alphabet: "a", words: ["w"] });
		const classes = new Set(["a", ...SEPARATOR_CLASSES]).size;
		const separators = SEPARATOR_CLASSES.length;
		// Runs and pairs; around a piece ("" or "w" before, "w" after); ended by
		// each terminator but the run's own; then a terminator and "w"; the
		// piece over and over, alone and with each separator; a periodic text
		// of each class and "a" at each period; and the word before each class
		// and with each class.
		const pairs = classes + classes * (classes - 1);
		const around = 2 * classes;
		const ended = 2 * (classes * separators - separators);
		const thenWord = 2 * separators;
		const repeatedPiece = 1 + separators;
		const periodic = PERIODS.length * (classes - 1);
		expect(inputs).toHaveLength(
			pairs +
				around +
				ended +
				thenWord +
				repeatedPiece +
				periodic +
				2 * classes,
		);
		expect(inputs.map((input) => input.name)).toContain('"_ " repeated');
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

	it("reads a pattern's alphabet from its classes", () => {
		// Literals and both ends of each range, negated classes too, the class
		// escapes' representatives, and the other case under `i`.
		expect(patternAlphabet(/(?<![\u017F\u212AA-Z_-])x[^@]\d/iu)).toBe(
			"\u017F\u212AAaZz_-xX@0",
		);
		expect(patternAlphabet(/[a-c]\s\S./u)).toBe("ac ");
	});

	it("builds periodic texts of one class and a period of another", () => {
		const periodic = sweepInputs({ alphabet: "ab" }).filter((input) =>
			input.name.includes("of"),
		);
		const long = periodic.find(
			(input) => input.name === '"a" and 63 of "b", repeated',
		);
		expect(long?.text(128)).toBe(`a${"b".repeat(63)}`.repeat(2));
		expect(long?.scale).toBe(8);
	});

	it("passes a linear call on one input, and names a hang", () => {
		expect(assertInputLinear(linearScan, repeatedTo("a")).ratio).toBeLessThan(
			32,
		);
		expect(() =>
			assertInputLinear(
				() => {
					throw new OperationHangError(2048, 25_000);
				},
				repeatedTo("a"),
				"hung",
			),
		).toThrow(SweepGrowthError);
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
