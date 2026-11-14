/**
 * Fleet verdicts on the cache (ADR-0180): the store of `@hobo/ci-gh-actions`
 * bound to the relay's ephemeral state, under three keys per repository: each
 * enrolled reporter's last report (until it expires), each reporter's state
 * (a day after its last report) and the repository's allowance (a day from
 * its window's start). The hosted relay keeps, agrees and serves; the box
 * relay decides.
 *
 * Losing the cache loses nothing that matters: a missing report reads as
 * "nothing blocked", which is what runner routing assumes without one, the
 * reporters send again within a minute, replay protection resumes from the
 * next accepted report, and the allowance window restarts.
 */
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

/** The relay's ephemeral state as the verdict store's key/value binding. */
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
