// Small seeded PRNG (splitmix32) for the built-in optimizer. Determinism is
// a contract of the engine: the caller supplies the seed, and the same seed
// over the same request replays the identical proposal trajectory. Never
// Math.random — an unseeded source would make training runs unreplayable.

/** A deterministic stream of floats in [0, 1) and bounded ints. */
export interface SeededPrng {
	/** Next float in [0, 1). */
	next(): number;
	/** Next integer in [0, bound), bound >= 1. */
	nextInt(bound: number): number;
}

/** Creates a splitmix32 PRNG from a 32-bit unsigned seed. */
export function createSeededPrng(seed: number): SeededPrng {
	let state = seed >>> 0;
	const next = (): number => {
		state = (state + 0x9e3779b9) >>> 0;
		let z = state;
		z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
		z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
		z ^= z >>> 15;
		return (z >>> 0) / 0x1_0000_0000;
	};
	return {
		next,
		nextInt(bound: number): number {
			return Math.floor(next() * bound);
		},
	};
}
