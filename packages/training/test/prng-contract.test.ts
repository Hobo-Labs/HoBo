import { expect, it } from "vitest";
import { createSeededPrng } from "../src/index.js";

it("rejects seeds outside the unsigned 32-bit integer contract", () => {
	for (const seed of [
		Number.NaN,
		Infinity,
		-Infinity,
		-1,
		0.5,
		2 ** 32,
		Number.MAX_SAFE_INTEGER,
	]) {
		expect(() => createSeededPrng(seed)).toThrow(/seed/);
	}
	for (const seed of [0, 1, 0xffff_ffff]) {
		expect(createSeededPrng(seed).next()).toBeGreaterThanOrEqual(0);
	}
});

it("rejects invalid bounds without consuming the stream", () => {
	const actual = createSeededPrng(42);
	const reference = createSeededPrng(42);
	for (const bound of [
		Number.NaN,
		Infinity,
		-Infinity,
		-1,
		0,
		0.5,
		1.5,
		Number.MAX_SAFE_INTEGER + 1,
	]) {
		expect(() => actual.nextInt(bound)).toThrow(/bound/);
	}
	for (let index = 0; index < 16; index++)
		expect(actual.next()).toBe(reference.next());
});

it("replays generated seeds and bounds while keeping draws in range", () => {
	let seed = 0xa361c5d7;
	const nextSeed = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed;
	};
	const bounds = [1, 2, 3, 65537, 2 ** 32, Number.MAX_SAFE_INTEGER];
	for (let trial = 0; trial < 100; trial++) {
		const caseSeed = nextSeed();
		const actual = createSeededPrng(caseSeed);
		const reference = createSeededPrng(caseSeed);
		for (const bound of bounds) {
			const expectedDraw = reference.next();
			const value = actual.nextInt(bound);
			expect(value).toBe(Math.floor(expectedDraw * bound));
			expect(Number.isSafeInteger(value)).toBe(true);
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(bound);
			const nextActual = actual.next();
			expect(nextActual).toBe(reference.next());
			expect(nextActual).toBeGreaterThanOrEqual(0);
			expect(nextActual).toBeLessThan(1);
		}
	}
});

it("matches fixed splitmix32 output vectors", () => {
	const cases = [
		{
			seed: 0,
			values: [1684164658, 3653269916, 2939563536, 2141751570, 3295091513],
		},
		{
			seed: 1,
			values: [1580013426, 350525680, 3524174333, 3011703609, 643872864],
		},
		{
			seed: 0xffff_ffff,
			values: [3950124170, 4293442868, 1302505678, 2762329221, 3361369063],
		},
	];
	for (const entry of cases) {
		const generator = createSeededPrng(entry.seed);
		const values = entry.values.map(() => generator.next() * 2 ** 32);
		expect(values).toEqual(entry.values);
	}
});
