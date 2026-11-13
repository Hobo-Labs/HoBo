/**
 * Fleet verdicts on the cache (ADR-0180): one key per repository, holding the
 * verdict a reporting relay last sent, with a time to live that ends when the
 * verdict does. The hosted relay only keeps and serves them; a relay with a
 * view of the fleet decides them.
 *
 * Losing the cache loses nothing that matters: a missing verdict reads as
 * "nothing blocked", which is what runner routing assumes without one, and
 * the reporter sends it again within a minute.
 */
import {
	type FleetVerdictStore,
	fleetVerdictExpiresAtMs,
	fleetVerdictJson,
	parseFleetVerdict,
} from "@hobo/ci-gh-actions";
import { relayCacheKeys, relayTtlUntil } from "@hobo/ci-gh-actions/relay-cache";
import type { EphemeralStatePort } from "@hobo/core";

export function createCacheFleetVerdicts(options: {
	state: EphemeralStatePort;
	environment: string;
	now?: () => number;
}): FleetVerdictStore {
	const keys = relayCacheKeys(options.environment);
	const now = options.now ?? Date.now;
	return {
		read: async (repository) => {
			const entry = await options.state.get(keys.fleetVerdict(repository));
			const verdict = entry && parseFleetVerdict(entry.value);
			const expiresAtMs = verdict && fleetVerdictExpiresAtMs(verdict);
			// The cache's own expiry is the rule; this covers the second it rounds to.
			return verdict && expiresAtMs !== undefined && expiresAtMs > now()
				? verdict
				: undefined;
		},
		write: async (verdict) => {
			const key = keys.fleetVerdict(verdict.repository);
			const expiresAtMs = fleetVerdictExpiresAtMs(verdict);
			if (expiresAtMs === undefined) {
				await options.state.delete(key);
				return;
			}
			const value = fleetVerdictJson(verdict);
			const ttl = relayTtlUntil(expiresAtMs, now());
			// The last report stands: a reporter repeats itself, so losing a race
			// to another write is retried, not merged.
			for (let attempt = 0; attempt < 8; attempt++) {
				const current = await options.state.get(key);
				const write = current
					? await options.state.compareAndSet(key, current.version, value, ttl)
					: await options.state.putIfAbsent(key, value, ttl);
				if (write.applied) return;
			}
			throw new Error("fleet verdict contended");
		},
	};
}
