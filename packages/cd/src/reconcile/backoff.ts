// Deterministic jittered backoff (D5). The jitter is derived from
// hash(reconcilerId, campId, attempt), so a fleet of reconcilers spreads its
// retries without an RNG and every replay computes the same delay (I8).
import { createHash } from "node:crypto";
import { CD_DEFAULTS } from "../events.js";

// public-contract: reconcile backoff bounds. Base 1 s (the shared backoff
// base); the cap is one lease TTL so a waiting reconciler retries a held lease
// at least once per lease lifetime.
export const RECONCILE_BACKOFF = Object.freeze({
	baseMs: CD_DEFAULTS.sourceBackoffBaseMs,
	maxMs: CD_DEFAULTS.leaseTtlMs,
});

/** Jitter fraction in [0.5, 1.0) derived from the inputs. */
export function jitterFraction(
	reconcilerId: string,
	campId: string,
	attempt: number,
): number {
	const hash = createHash("sha256")
		.update(`${reconcilerId}\u0000${campId}\u0000${attempt}`)
		.digest();
	return 0.5 + hash.readUInt32BE(0) / 2 ** 33;
}

/** Delay before retry `attempt` (0-based) for one reconciler and Camp. */
export function backoffMs(
	reconcilerId: string,
	campId: string,
	attempt: number,
	bounds: Readonly<{ baseMs: number; maxMs: number }> = RECONCILE_BACKOFF,
): number {
	const step = Math.max(0, Math.min(attempt, 30));
	const ceiling = Math.min(bounds.maxMs, bounds.baseMs * 2 ** step);
	return Math.floor(ceiling * jitterFraction(reconcilerId, campId, attempt));
}
