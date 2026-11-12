/**
 * Stand-ins for the replica tests: one in-memory ephemeral-state store per
 * backend (the shared Redis-protocol binding over the in-memory engine, each
 * with its own clock), which a test can wipe as a flushed or evicting cache
 * would, or make unreachable.
 */
import type {
	EphemeralKey,
	EphemeralStatePort,
	EphemeralTtlMs,
	EphemeralVersion,
	IncrementTtlMode,
} from "@hobo/core";
import { createMemoryEphemeralState } from "@hobo/kv-redis-compatible";
import {
	type EphemeralAssignmentReplica,
	ephemeralAssignmentRegister,
	ephemeralAssignmentReplica,
	type FleetAssignment,
	type FleetAssignmentValue,
	parseFleetAssignment,
} from "../src/index.js";

export const LOG_KEY = "hobo-ci:test:fleet:assignment";

/** One backend's store: a clock of its own, a wipe, and an off switch. */
export type TestBackend = {
	readonly id: string;
	readonly state: EphemeralStatePort;
	nowMs: number;
	down: boolean;
	wipe(): void;
};

export function testBackend(id: string, startMs = 1_000_000): TestBackend {
	const fresh = () => createMemoryEphemeralState({ now: () => backend.nowMs });
	let inner: EphemeralStatePort | undefined;
	const guard = <T>(run: (port: EphemeralStatePort) => Promise<T>) => {
		if (backend.down) return Promise.reject(new Error("cache unreachable"));
		inner ??= fresh();
		return run(inner);
	};
	const state: EphemeralStatePort = {
		get: (key: EphemeralKey) => guard((port) => port.get(key)),
		getMany: (keys: readonly EphemeralKey[]) =>
			guard((port) => port.getMany(keys)),
		putIfAbsent: (key: EphemeralKey, value: string, ttl: EphemeralTtlMs) =>
			guard((port) => port.putIfAbsent(key, value, ttl)),
		compareAndSet: (
			key: EphemeralKey,
			expected: EphemeralVersion,
			value: string,
			ttl: EphemeralTtlMs,
		) => guard((port) => port.compareAndSet(key, expected, value, ttl)),
		delete: (key: EphemeralKey, expected?: EphemeralVersion) =>
			guard((port) => port.delete(key, expected)),
		increment: (
			key: EphemeralKey,
			by: number,
			ttl: EphemeralTtlMs,
			mode?: IncrementTtlMode,
		) => guard((port) => port.increment(key, by, ttl, mode)),
		expire: (key: EphemeralKey, ttl: EphemeralTtlMs) =>
			guard((port) => port.expire(key, ttl)),
	};
	const backend: TestBackend = {
		id,
		state,
		nowMs: startMs,
		down: false,
		wipe() {
			inner = fresh();
		},
	};
	return backend;
}

export function cacheFleet(count: number, maxEntries?: number) {
	const backends = Array.from({ length: count }, (_, index) =>
		testBackend(`c${index}`),
	);
	const options =
		maxEntries === undefined ? { key: LOG_KEY } : { key: LOG_KEY, maxEntries };
	const replicas: EphemeralAssignmentReplica[] = backends.map((backend) =>
		ephemeralAssignmentReplica(backend.state, backend.id, options),
	);
	return {
		backends,
		replicas,
		register: ephemeralAssignmentRegister(replicas),
		backend(id: string): TestBackend {
			const found = backends.find((backend) => backend.id === id);
			if (!found) throw new Error(`no backend ${id}`);
			return found;
		},
	};
}

export function entry(
	epoch: number,
	active: string | undefined,
	overrides: Partial<FleetAssignment> = {},
): FleetAssignment {
	return parseFleetAssignment({
		epoch,
		active,
		sealed: false,
		target: undefined,
		reason: "test",
		lossWindowMs: undefined,
		decidedAtMs: epoch,
		decidedBy: "test",
		...overrides,
	});
}

export function writer(active: string): FleetAssignmentValue {
	return {
		active,
		sealed: false,
		target: undefined,
		reason: "test",
		lossWindowMs: undefined,
	};
}

/** A small seeded generator, so a randomized run is repeatable. */
export function seeded(seed: number) {
	let state = seed >>> 0;
	return {
		next(): number {
			state = (state * 1_664_525 + 1_013_904_223) >>> 0;
			return state / 2 ** 32;
		},
		pick<T>(items: readonly T[]): T {
			const item = items[Math.floor(this.next() * items.length)];
			if (item === undefined) throw new Error("empty pick");
			return item;
		},
	};
}
