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
