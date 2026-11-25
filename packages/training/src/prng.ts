export interface SeededPrng {
	next(): number;
	nextInt(bound: number): number;
}

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
