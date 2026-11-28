import { createHash } from "node:crypto";
import { CD_DEFAULTS } from "../events.js";

export function jitterFraction(source: string, attempt: number): number {
	const bytes = createHash("sha256")
		.update(`${source}\u0000${attempt}`)
		.digest();
	return bytes.readUInt32BE(0) / 0x1_0000_0000;
}

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
