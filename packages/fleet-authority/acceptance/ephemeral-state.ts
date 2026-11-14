/**
 * An in-memory `EphemeralStatePort` (`@hobo/core`): one per one-active
 * member, holding that member's replica of the assignment log, for the
 * one-active scenarios of the behaviour suite. Versions are a revision
 * counter; expiry follows the world's clock.
 */
import {
	type EphemeralEntry,
	type EphemeralKey,
	type EphemeralStatePort,
	type EphemeralTtlMs,
	type EphemeralVersion,
	parseEphemeralVersion,
} from "@hobo/core";

type Stored = { value: string; revision: number; expiresAtMs: number };

export function createMemoryEphemeralState(
	now: () => number,
): EphemeralStatePort {
	const store = new Map<string, Stored>();
	let revisions = 0;
	const live = (key: EphemeralKey): Stored | undefined => {
		const stored = store.get(key);
		if (stored !== undefined && stored.expiresAtMs <= now()) store.delete(key);
		return store.get(key);
	};
	const versionOf = (stored: Stored): EphemeralVersion =>
		parseEphemeralVersion(`r${stored.revision}`);
	const entryOf = (stored: Stored | undefined): EphemeralEntry | undefined =>
		stored === undefined
			? undefined
			: { value: stored.value, version: versionOf(stored) };
	const write = (key: EphemeralKey, value: string, ttlMs: EphemeralTtlMs) => {
		revisions += 1;
		const stored = { value, revision: revisions, expiresAtMs: now() + ttlMs };
		store.set(key, stored);
		return { applied: true, version: versionOf(stored) } as const;
	};
	return {
		async get(key) {
			return entryOf(live(key));
		},
		async getMany(keys) {
			return keys.map((key) => entryOf(live(key)));
		},
		async putIfAbsent(key, value, ttlMs) {
			return live(key) === undefined
				? write(key, value, ttlMs)
				: { applied: false };
		},
		async compareAndSet(key, expected, value, ttlMs) {
			const stored = live(key);
			return stored !== undefined && versionOf(stored) === expected
				? write(key, value, ttlMs)
				: { applied: false };
		},
		async delete(key, expected) {
			const stored = live(key);
			if (
				stored === undefined ||
				(expected !== undefined && versionOf(stored) !== expected)
			)
				return false;
			store.delete(key);
			return true;
		},
		async increment(key, by, ttlMs, mode = "on-create") {
			const stored = live(key);
			const current = stored === undefined ? 0 : Number(stored.value);
			if (!Number.isSafeInteger(current))
				throw new Error(`${key} does not hold an integer`);
			const next = current + by;
			if (stored === undefined || mode === "refresh")
				write(key, String(next), ttlMs);
			else {
				revisions += 1;
				store.set(key, { ...stored, value: String(next), revision: revisions });
			}
			return next;
		},
		async expire(key, ttlMs) {
			const stored = live(key);
			if (stored === undefined) return false;
			stored.expiresAtMs = now() + ttlMs;
			return true;
		},
	};
}
