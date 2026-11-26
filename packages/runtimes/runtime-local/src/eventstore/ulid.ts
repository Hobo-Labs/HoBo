import type { Clock } from "@hobo/core";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

export function createUlidGenerator(clock: Clock) {
	let lastInstant = "";
	let increment = 0;

	return function nextUlid(): string {
		const instant = clock.now();
		const timeMs = Date.parse(instant);
		if (Number.isNaN(timeMs)) {
			throw new TypeError("clock.now() must return a valid ISO-8601 instant");
		}

		if (instant === lastInstant) {
			increment += 1;
		} else {
			lastInstant = instant;
			increment = 0;
		}

		const timePart = encodeTime(timeMs);
		const randomPart = encodeRandom(increment);
		return `${timePart}${randomPart}`;
	};
}

function encodeTime(timeMs: number): string {
	let value = timeMs;
	let output = "";
	for (let index = 0; index < TIME_LEN; index += 1) {
		output = ENCODING[value % 32] + output;
		value = Math.floor(value / 32);
	}
	return output;
}

function encodeRandom(increment: number): string {
	let value = increment;
	let output = "";
	for (let index = 0; index < RANDOM_LEN; index += 1) {
		output += ENCODING[value % 32];
		value = Math.floor(value / 32);
	}
	return output;
}
