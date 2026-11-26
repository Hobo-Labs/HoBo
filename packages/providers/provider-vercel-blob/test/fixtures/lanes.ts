/**
 * Conformance contexts for the Blob binding, all offline:
 *
 * - the in-memory store with four clients, an injected clock and no backoff
 *   delay: the fastest lane, every race decided by await order;
 * - the in-memory store with eight clients, a random delay before every call
 *   reaches the store and the binding's default jittered backoff: concurrent
 *   clients interleave between each read and its conditional write;
 * - the real `@vercel/blob` 2.8.2 SDK over HTTP to the local emulator, three
 *   clients: requests, headers and error decoding are the SDK's own.
 *
 * `usage` counts port calls on `clients[0]`. The suite's cost case asserts
 * the Redis-protocol table (`EPHEMERAL_STATE_COMMAND_COST`, one command per
 * call), which on this binding checks that the lock and ring helpers make
 * the documented number of port calls; what each call costs in Blob
 * operations is pinned separately by `blob-cost.test.ts` against
 * `VERCEL_BLOB_EPHEMERAL_COST`.
 */
import type { EphemeralStatePort } from "@hobo/core";
import {
	type CommandUsage,
	createManualClock,
	type EphemeralConformanceContext,
} from "@hobo/kv-redis-compatible";

import {
	createMemoryBlobSdk,
	createVercelBlobEphemeralState,
	type VercelBlobSdk,
} from "../../src/index.js";
import { startBlobEmulator } from "./http-emulator.js";
import { sdkOverHttp, useEmulatorEnv } from "./sdk-over-http.js";

export type BlobLane = {
	readonly context: EphemeralConformanceContext;
	close(): Promise<void>;
};

export type CountedPort = {
	readonly port: EphemeralStatePort;
	usage(): CommandUsage;
};

/** Wrap a port so every call is counted by method. */
export function countPortCalls(port: EphemeralStatePort): CountedPort {
	const byVerb: Record<string, number> = {};
	let total = 0;
	const count = (method: string) => {
		total += 1;
		byVerb[method] = (byVerb[method] ?? 0) + 1;
	};
	return {
		port: {
			get(...args) {
				count("get");
				return port.get(...args);
			},
			getMany(...args) {
				count("getMany");
				return port.getMany(...args);
			},
			putIfAbsent(...args) {
				count("putIfAbsent");
				return port.putIfAbsent(...args);
			},
			compareAndSet(...args) {
				count("compareAndSet");
				return port.compareAndSet(...args);
			},
			delete(...args) {
				count("delete");
				return port.delete(...args);
			},
			increment(...args) {
				count("increment");
				return port.increment(...args);
			},
			expire(...args) {
				count("expire");
				return port.expire(...args);
			},
		},
		usage: () => ({ total, byVerb: { ...byVerb } }),
	};
}

const immediate = () => new Promise<void>((resolve) => setImmediate(resolve));

function clients(
	count: number,
	sdk: VercelBlobSdk,
	now: () => number,
	sleep: ((ms: number) => Promise<void>) | undefined,
): [EphemeralStatePort, ...EphemeralStatePort[]] {
	const make = () =>
		createVercelBlobEphemeralState({
			sdk,
			storeId: "store_conformance",
			namespace: "conformance",
			now,
			retry: sleep === undefined ? {} : { sleep },
		});
	return [make(), ...Array.from({ length: count - 1 }, make)];
}

function lane(
	ports: [EphemeralStatePort, ...EphemeralStatePort[]],
	advanceTime: (ms: number) => Promise<void>,
	keyPrefix: string,
	close: () => Promise<void>,
): BlobLane {
	const [first, ...rest] = ports;
	const counted = countPortCalls(first);
	return {
		context: {
			clients: [counted.port, ...rest],
			advanceTime,
			usage: counted.usage,
			keyPrefix,
			ttlMs: 1_000,
		},
		close,
	};
}

export function memoryLane(): BlobLane {
	const clock = createManualClock(1_800_000_000_000);
	const sdk = createMemoryBlobSdk({ now: clock.now });
	return lane(
		clients(4, sdk, clock.now, immediate),
		async (ms) => clock.advance(ms),
		"memory:",
		async () => {},
	);
}

export function shuffledLane(): BlobLane {
	const clock = createManualClock(1_800_000_000_000);
	const sdk = createMemoryBlobSdk({
		now: clock.now,
		delay: () =>
			new Promise<void>((resolve) => setTimeout(resolve, Math.random() * 2)),
	});
	return lane(
		clients(8, sdk, clock.now, undefined),
		async (ms) => clock.advance(ms),
		"shuffled:",
		async () => {},
	);
}

export async function httpLane(): Promise<BlobLane> {
	const clock = createManualClock(1_800_000_000_000);
	const emulator = await startBlobEmulator({ now: clock.now });
	const restore = useEmulatorEnv(emulator.apiUrl);
	return lane(
		clients(3, sdkOverHttp(emulator.origin), clock.now, immediate),
		async (ms) => clock.advance(ms),
		"http:",
		async () => {
			restore();
			await emulator.close();
		},
	);
}
