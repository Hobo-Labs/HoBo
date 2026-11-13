// Replay protection in memory, ported from the delivery stack's
// `packages/cd/src/agent/replay.ts`. The journal-backed store there wrote a
// cd-specific event; the fleet's durable replay store is the bus's
// `ReplayStore` (L08), so what is ported here is the claim-once rule itself:
// a (scope, id) pair is accepted once until its own expiry, and expired
// entries are dropped as the clock passes them.
import type { Clock, ReplayStore } from "../ports.js";

export function createMemoryReplayStore(now: Clock): ReplayStore {
	const seen = new Map<string, number>();
	return Object.freeze({
		async firstUse(scope: string, id: string, expiresAtMs: number) {
			const at = now();
			for (const [key, until] of seen) if (until <= at) seen.delete(key);
			const key = `${scope}\u0000${id}`;
			if (seen.has(key)) return false;
			seen.set(key, expiresAtMs);
			return true;
		},
	} satisfies ReplayStore);
}
