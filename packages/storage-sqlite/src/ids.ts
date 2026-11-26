/** Deterministic ULID-compatible id generation from a clock + counter. */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function createUlidGenerator(
	clock: { now(): string },
	initialCounter = 0,
): () => string {
	if (!Number.isSafeInteger(initialCounter) || initialCounter < 0)
		throw new TypeError("initialCounter must be a nonnegative safe integer");
	let lastMs = Date.parse(clock.now());
	let counter = initialCounter - 1;

	return () => {
		const nowMs = Date.parse(clock.now());
		const ms = Number.isFinite(nowMs) ? nowMs : Date.now();
		if (ms === lastMs) {
			counter += 1;
		} else {
			lastMs = ms;
			counter = 0;
		}
		let time = ms;
		let timePart = "";
		for (let i = 0; i < 10; i++) {
			timePart = CROCKFORD[time % 32] + timePart;
			time = Math.floor(time / 32);
		}
		// 16 chars of entropy: mix counter + fixed seed for tests. Sample the
		// HIGH bits of the LCG state — the low bits of a mod-2^32 LCG cycle
		// with period 32, which made the 33rd id within one millisecond
		// collide with the first (UNIQUE constraint on events.id).
		let entropy = "";
		let n = (counter * 0x9e37_79b9) >>> 0;
		for (let i = 0; i < 16; i++) {
			entropy += CROCKFORD[(n >>> 27) & 31];
			n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
		}
		return timePart + entropy;
	};
}

export function createDeterministicId(
	prefix: string,
	parts: readonly string[],
): string {
	return `${prefix}:${parts.join(":")}`;
}
