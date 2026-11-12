/**
 * Every port call's Blob operations, counted at the SDK by
 * `meterVercelBlobSdk`, against `VERCEL_BLOB_EPHEMERAL_COST`: the figures the
 * README's cost table and the relay's budget rest on.
 */
import {
	acquireEphemeralLock,
	createEphemeralRing,
	parseEphemeralKey,
	parseEphemeralTtlMs,
	releaseEphemeralLock,
	renewEphemeralLock,
} from "@hobo/core";
import { createManualClock } from "@hobo/kv-redis-compatible";
import { describe, expect, it } from "vitest";

import {
	createMemoryBlobSdk,
	createVercelBlobEphemeralState,
	meterVercelBlobSdk,
	purgeExpiredBlobs,
	VERCEL_BLOB_EPHEMERAL_COST,
	type VercelBlobEphemeralOperation,
	vercelBlobProOperationsUsd,
} from "../src/index.js";

const key = parseEphemeralKey;
const ttl = parseEphemeralTtlMs(60_000);

function setup() {
	const clock = createManualClock(1_800_000_000_000);
	const sdk = meterVercelBlobSdk(createMemoryBlobSdk({ now: clock.now }));
	const port = createVercelBlobEphemeralState({ sdk, now: clock.now });
	const measure = async <T>(
		operation: VercelBlobEphemeralOperation,
		call: () => Promise<T>,
		times = 1,
	) => {
		sdk.reset();
		await call();
		const { simple, advanced, deletes } = sdk.usage();
		const cost = VERCEL_BLOB_EPHEMERAL_COST[operation];
		expect({ operation, simple, advanced, deletes }).toEqual({
			operation,
			simple: cost.simple * times,
			advanced: cost.advanced * times,
			deletes: cost.deletes * times,
		});
	};
	return { clock, sdk, port, measure };
}

describe("VERCEL_BLOB_EPHEMERAL_COST matches the SDK calls made", () => {
	it("key-value calls", async () => {
		const { clock, port, measure } = setup();
		await measure("get", () => port.get(key("k:absent")));
		await measure("putIfAbsent", () => port.putIfAbsent(key("k:a"), "1", ttl));
		await measure("putIfAbsent.lost", () =>
			port.putIfAbsent(key("k:a"), "2", ttl),
		);
		await measure("get", () => port.get(key("k:a")));
		await measure(
			"getMany",
			() => port.getMany([key("k:a"), key("k:b"), key("k:a"), key("k:c")]),
			3,
		);
		const current = await port.get(key("k:a"));
		if (current === undefined) throw new Error("setup");
		await measure("compareAndSet", () =>
			port.compareAndSet(key("k:a"), current.version, "3", ttl),
		);
		await measure("compareAndSet.stale", () =>
			port.compareAndSet(key("k:a"), current.version, "4", ttl),
		);
		await measure("increment", () => port.increment(key("k:n"), 1, ttl));
		await measure("increment", () => port.increment(key("k:n"), 1, ttl));
		await measure("expire", () => port.expire(key("k:n"), ttl));
		await measure("delete", () => port.delete(key("k:n")));

		await port.putIfAbsent(key("k:old"), "x", ttl);
		clock.advance(ttl + 1);
		await measure("putIfAbsent.replacesExpired", () =>
			port.putIfAbsent(key("k:old"), "y", ttl),
		);
	});

	it("lock and ring helpers", async () => {
		const { port, measure } = setup();
		await measure("lock.acquire", () =>
			acquireEphemeralLock(port, key("lock"), "me", ttl),
		);
		const lease = await acquireEphemeralLock(port, key("lock2"), "me", ttl);
		if (lease === undefined) throw new Error("setup");
		let renewed = lease;
		await measure("lock.renew", async () => {
			renewed = (await renewEphemeralLock(port, lease, ttl)) ?? lease;
		});
		await measure("lock.release", () => releaseEphemeralLock(port, renewed));

		const ring = createEphemeralRing(port, {
			name: "cost",
			capacity: 2,
			ttlMs: ttl,
		});
		await ring.append("1");
		await ring.append("2");
		await measure("ring.append", () => ring.append("3"));
		// get(seq) + one read per sequence in the window of two.
		await measure("ring.read", () => ring.read(0), 3);
	});

	it("a purge pass lists one page per call", async () => {
		const { sdk, clock, measure } = setup();
		await measure("purge.listPage", () =>
			purgeExpiredBlobs({ sdk, now: clock.now, maxReads: 0 }),
		);
	});

	it("a lost race costs one conflict round per retry", async () => {
		const clock = createManualClock(1_800_000_000_000);
		const memory = createMemoryBlobSdk({ now: clock.now });
		const sdk = meterVercelBlobSdk(memory);
		const port = createVercelBlobEphemeralState({ sdk, now: clock.now });
		const other = createVercelBlobEphemeralState({
			sdk: memory,
			now: clock.now,
		});
		await port.increment(key("hot"), 1, ttl);
		let interfered = false;
		const racing = createVercelBlobEphemeralState({
			sdk: {
				...sdk,
				async put(pathname, body, options) {
					if (!interfered) {
						interfered = true;
						await other.increment(key("hot"), 10, ttl);
					}
					return sdk.put(pathname, body, options);
				},
			},
			now: clock.now,
			retry: { sleep: async () => {} },
		});
		sdk.reset();
		expect(await racing.increment(key("hot"), 1, ttl)).toBe(12);
		const { increment, conflictRound } = VERCEL_BLOB_EPHEMERAL_COST;
		const { simple, advanced } = sdk.usage();
		expect({ simple, advanced }).toEqual({
			simple: increment.simple + conflictRound.simple,
			advanced: increment.advanced + conflictRound.advanced,
		});
	});
});

describe("Pro pricing", () => {
	it("prices a month of relay leases from the cost table", () => {
		// acquire + renew + release + one feed append, 1,000 leases a day.
		const lease: readonly VercelBlobEphemeralOperation[] = [
			"lock.acquire",
			"lock.renew",
			"lock.release",
			"ring.append",
		];
		const perLease = lease
			.map((name) => VERCEL_BLOB_EPHEMERAL_COST[name])
			.reduce(
				(sum, cost) => ({
					simple: sum.simple + cost.simple,
					advanced: sum.advanced + cost.advanced,
					deletes: sum.deletes + cost.deletes,
				}),
				{ simple: 0, advanced: 0, deletes: 0 },
			);
		expect(perLease).toEqual({ simple: 4, advanced: 4, deletes: 2 });
		const month = {
			simple: perLease.simple * 30_000,
			advanced: perLease.advanced * 30_000,
			deletes: perLease.deletes * 30_000,
		};
		expect(vercelBlobProOperationsUsd(month)).toBeCloseTo(0.648, 6);
	});
});
