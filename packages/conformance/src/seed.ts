import type { CaseContext } from "./types.js";

export function createSeededRandom(seed: string): () => number {
	let state = 2166136261;
	for (let index = 0; index < seed.length; index += 1) {
		state ^= seed.charCodeAt(index);
		state = Math.imul(state, 16777619);
	}

	return () => {
		state += 0x6d2b79f5;
		let mixed = state;
		mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
	};
}

export function createCaseContext(seed: string, caseId: string): CaseContext {
	return {
		seed,
		caseId,
		random: createSeededRandom(`${seed}:${caseId}`),
	};
}
