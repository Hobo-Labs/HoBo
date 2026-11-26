// Poll scheduling for `tick`: interval polling with exponential, jittered,
// deterministic backoff. The jitter is derived from sha256(source, attempt),
// so the schedule is replayable (I8) yet different sources do not retry in
// lock-step. Retry-After from a rate-limit is a floor, never shortened.
import { createHash } from "node:crypto";
import { CD_DEFAULTS } from "../events.js";

/** A deterministic fraction in [0, 1) for one source and attempt. */
export function jitterFraction(source: string, attempt: number): number {
	const bytes = createHash("sha256")
		.update(`${source}\u0000${attempt}`)
		.digest();
	return bytes.readUInt32BE(0) / 0x1_0000_0000;
}

/** Delay before retry `attempt` (1-based): full exponential cap, jittered into [50%, 100%]. */
export function backoffDelayMs(
	source: string,
	attempt: number,
	retryAfterMs = 0,
): number {
	const exponent = Math.min(Math.max(attempt - 1, 0), 30);
	const cap = Math.min(
		CD_DEFAULTS.sourceBackoffMaxMs,
		CD_DEFAULTS.sourceBackoffBaseMs * 2 ** exponent,
	);
	const jittered = Math.round(
		cap * (0.5 + 0.5 * jitterFraction(source, attempt)),
	);
	return Math.max(
		Math.min(CD_DEFAULTS.sourceBackoffMaxMs, jittered),
		retryAfterMs,
	);
}
