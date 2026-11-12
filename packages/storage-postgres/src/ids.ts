const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * ULID-shaped event id derived from the event's timestamp and its global
 * position. Positions are allocated under the partition-head row lock, so
 * they are unique within a store schema; deriving the id from them makes ids
 * unique across every process writing that schema, with no RNG and no
 * per-process counter (replay- and test-deterministic, I8).
 *
 * Layout: 10 Crockford characters of epoch milliseconds, then 16 characters
 * (80 bits) of the position.
 */
export function eventIdFor(timestampMs: number, position: bigint): string {
	if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
		throw new TypeError("timestampMs must be a non-negative safe integer");
	}
	if (position <= 0n || position >= 1n << 80n) {
		throw new TypeError("position must be within 1..2^80-1");
	}
	let time = timestampMs;
	let timePart = "";
	for (let index = 0; index < 10; index += 1) {
		timePart = CROCKFORD[time % 32] + timePart;
		time = Math.floor(time / 32);
	}
	let rest = position;
	let positionPart = "";
	for (let index = 0; index < 16; index += 1) {
		positionPart = CROCKFORD[Number(rest % 32n)] + positionPart;
		rest /= 32n;
	}
	return timePart + positionPart;
}
