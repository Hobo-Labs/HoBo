import {
	createFleetVerdictStore,
	type FleetVerdictKv,
	type FleetVerdictStore,
} from "@hobo/ci-gh-actions";
import { relayCacheKeys, relayTtlUntil } from "@hobo/ci-gh-actions/relay-cache";
import type {
	EphemeralKey,
	EphemeralStatePort,
	EphemeralVersion,
} from "@hobo/core";

function cacheKv(
	state: EphemeralStatePort,
	now: () => number,
): FleetVerdictKv<EphemeralKey, EphemeralVersion> {
	return {
		getMany: (keys) => state.getMany(keys),
		write: async (key, value, ttlMs, expected) => {
			const nowMs = now();
			const ttl = relayTtlUntil(nowMs + ttlMs, nowMs);
			const written =
				expected === undefined
					? await state.putIfAbsent(key, value, ttl)
					: await state.compareAndSet(key, expected, value, ttl);
			return written.applied;
		},
	};
}

export function createCacheFleetVerdicts(options: {
	state: EphemeralStatePort;
	environment: string;
	now?: () => number;
}): FleetVerdictStore {
	const keys = relayCacheKeys(options.environment);
	const now = options.now ?? Date.now;
	return createFleetVerdictStore({
		kv: cacheKv(options.state, now),
		keys: {
			verdict: keys.fleetVerdict,
			reporter: keys.fleetReporter,
			allowance: keys.fleetAllowance,
		},
		now,
	});
}
