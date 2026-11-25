import { createHash } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface SeededClock {
	nowMs(): number;
	nowIso(): string;
	tick(): number;
}

export function createSeededClock(
	startMs = Date.parse("2026-01-01T00:00:00.000Z"),
	stepMs = 1_000,
): SeededClock {
	let current = startMs;
	return {
		nowMs: () => current,
		nowIso: () => new Date(current).toISOString(),
		tick: () => {
			current += stepMs;
			return current;
		},
	};
}

export interface SeededUlid {
	next(atMs: number): string;
}

export function createSeededUlid(seed: string): SeededUlid {
	let counter = 0;
	return {
		next(atMs: number) {
			const index = counter++;
			const randomness = deriveRandomness(seed, index);
			return encodeTime(atMs) + randomness;
		},
	};
}

function encodeTime(ms: number): string {
	let value = Math.floor(ms);
	const chars: string[] = [];
	for (let position = 0; position < 10; position += 1) {
		const mod = value % 32;
		chars.push(CROCKFORD[mod] as string);
		value = (value - mod) / 32;
	}
	return chars.reverse().join("");
}

function deriveRandomness(seed: string, index: number): string {
	const digest = createHash("sha256").update(`${seed}:${index}`).digest("hex");
	let out = "";
	for (let position = 0; position < 16; position += 1) {
		const byte = Number.parseInt(
			digest.slice(position * 2, position * 2 + 2),
			16,
		);
		out += CROCKFORD[byte % 32] as string;
	}
	return out;
}
