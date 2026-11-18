import { expect, it } from "vitest";
import {
	parseOptimizerConfig,
	TrainingOptimizerParseError,
} from "../src/index.js";

const maximum = 0xffff_ffff;

it("accepts the positive uint32 boundaries for optimizer counts", () => {
	for (const count of [1, 2, maximum]) {
		const config = parseOptimizerConfig({
			seed: 0,
			maxIterations: count,
			demosPerCandidate: count,
		});
		expect(config.maxIterations).toBe(count);
		expect(config.demosPerCandidate).toBe(count);
	}
});

it("rejects invalid counts with the matching typed error path", () => {
	const invalid = [0, -1, 0.5, 2 ** 32, 2 ** 53, 1e100, Number.NaN, Infinity];
	for (const count of invalid) {
		for (const field of ["maxIterations", "demosPerCandidate"] as const) {
			try {
				parseOptimizerConfig({ seed: 7, [field]: count });
				expect.unreachable("invalid count must be rejected");
			} catch (error) {
				expect(error).toBeInstanceOf(TrainingOptimizerParseError);
				expect(error).toMatchObject({ path: `config.${field}` });
			}
		}
	}
});

it("checks generated values on either side of the uint32 boundary", () => {
	let seed = 0x3459a712;
	for (let trial = 0; trial < 100; trial++) {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		const valid = seed === 0 ? 1 : seed;
		const config = parseOptimizerConfig({
			seed: 1,
			maxIterations: valid,
			demosPerCandidate: valid,
		});
		expect(config.maxIterations).toBe(valid);
		expect(config.demosPerCandidate).toBe(valid);
		const invalid = valid + 2 ** 32;
		expect(() =>
			parseOptimizerConfig({ seed: 1, maxIterations: invalid }),
		).toThrow(TrainingOptimizerParseError);
		expect(() =>
			parseOptimizerConfig({ seed: 1, demosPerCandidate: invalid }),
		).toThrow(TrainingOptimizerParseError);
	}
});
