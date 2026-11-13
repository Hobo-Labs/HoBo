/**
 * An in-memory `EphemeralStatePort` for the assignment tests.
 *
 * `@hobo/fleet` depends only on `@hobo/core`, so the moved replica tests
 * cannot reach `@hobo/kv-redis-compatible`'s in-memory binding. This double
 * keeps that binding's observable semantics, which is all the replica relies
 * on: a per-key version `<incarnation>:<revision>` (a new incarnation each time
 * a key is created, the revision counting writes to it), a TTL on every
 * write, an expired key reading as absent, and conditional writes that fail
 * as lost races rather than errors.
 */
import {
	type EphemeralEntry,
	type EphemeralKey,
	type EphemeralStatePort,
	type EphemeralTtlMs,
	type EphemeralVersion,
	type EphemeralWrite,
	type IncrementTtlMode,
	parseEphemeralVersion,
} from "@hobo/core";

type Stored = {
	value: string;
	incarnation: string;
	revision: number;
	expiresAtMs: number;
};

export type MemoryEphemeralStateOptions = Readonly<{
	now?: () => number;
	newIncarnation?: () => string;
}>;

export function createMemoryEphemeralState(
	options: MemoryEphemeralStateOptions = {},
): EphemeralStatePort {
	const now = options.now ?? Date.now;
	let created = 0;
	const newIncarnation =
		options.newIncarnation ??
		(() => {
			created += 1;
			return `mem${created}`;
		});
	const store = new Map<string, Stored>();

	const live = (key: EphemeralKey): Stored | undefined => {
		const stored = store.get(key);
		if (stored === undefined) return undefined;
		if (stored.expiresAtMs <= now()) {
			store.delete(key);
			return undefined;
		}
		return stored;
	};
	const versionOf = (stored: Stored): EphemeralVersion =>
		parseEphemeralVersion(`${stored.incarnation}:${stored.revision}`);
	const entryOf = (stored: Stored | undefined): EphemeralEntry | undefined =>
		stored === undefined
			? undefined
			: { value: stored.value, version: versionOf(stored) };

	return {
		async get(key) {
			return entryOf(live(key));
		},
		async getMany(keys) {
			return keys.map((key) => entryOf(live(key)));
		},
		async putIfAbsent(
			key,
			value,
			ttlMs: EphemeralTtlMs,
		): Promise<EphemeralWrite> {
			if (live(key) !== undefined) return { applied: false };
			const stored: Stored = {
				value,
				incarnation: newIncarnation(),
				revision: 1,
				expiresAtMs: now() + ttlMs,
			};
			store.set(key, stored);
			return { applied: true, version: versionOf(stored) };
		},
		async compareAndSet(key, expected, value, ttlMs): Promise<EphemeralWrite> {
			const stored = live(key);
			if (stored === undefined || versionOf(stored) !== expected)
				return { applied: false };
			stored.value = value;
			stored.revision += 1;
			stored.expiresAtMs = now() + ttlMs;
			return { applied: true, version: versionOf(stored) };
		},
		async delete(key, expected) {
			const stored = live(key);
			if (stored === undefined) return false;
			if (expected !== undefined && versionOf(stored) !== expected)
				return false;
			store.delete(key);
			return true;
		},
		async increment(key, by, ttlMs, mode: IncrementTtlMode = "on-create") {
			const stored = live(key);
			const current = stored === undefined ? 0 : Number(stored.value);
			if (!Number.isSafeInteger(current))
				throw new Error("the key does not hold an integer");
			const next = current + by;
			if (stored === undefined)
				store.set(key, {
					value: String(next),
					incarnation: newIncarnation(),
					revision: 1,
					expiresAtMs: now() + ttlMs,
				});
			else {
				stored.value = String(next);
				stored.revision += 1;
				if (mode === "refresh") stored.expiresAtMs = now() + ttlMs;
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
