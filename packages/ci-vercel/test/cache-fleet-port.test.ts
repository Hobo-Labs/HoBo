/**
 * The cache fleet's port and close over two in-memory members: `expire` is
 * routed to the active member like every other call, and closing the fleet
 * closes every member even when one of them fails to close.
 */
import { parseEphemeralKey, parseEphemeralTtlMs } from "@hobo/core";
import {
	createMemoryRedisExecutor,
	createRedisEphemeralState,
} from "@hobo/kv-redis-compatible";
import { describe, expect, it, vi } from "vitest";
import type {
	CacheBackendId,
	OpenedCacheBackend,
} from "../src/cache-backend.js";
import { createCacheFleet } from "../src/cache-fleet.js";
import { parseCacheOffers } from "../src/cache-offers.js";

function member(id: CacheBackendId, close: () => Promise<void>) {
	return {
		binding: { id, kind: "redis-protocol", names: [] },
		state: createRedisEphemeralState({ executor: createMemoryRedisExecutor() }),
		units: ["commands"],
		usage: () => ({ commands: 0 }),
		close: vi.fn(close),
	} satisfies OpenedCacheBackend;
}

describe("the cache fleet's port", () => {
	it("routes expire to the active member, and closes every member", async () => {
		const valkey = member("valkey", async () => undefined);
		const redis = member("redis", async () => {
			throw new Error("socket already closed");
		});
		let now = 1_700_000_000_000;
		const fleet = createCacheFleet({
			backends: [valkey, redis],
			environment: "test",
			offers: parseCacheOffers(undefined),
			now: () => now,
			log: () => undefined,
			scheduleActivation: async () => undefined,
			sleep: async (ms) => {
				now += ms;
			},
		});
		const key = parseEphemeralKey("k");
		const ttl = parseEphemeralTtlMs(60_000);
		await fleet.state.putIfAbsent(key, "v", ttl);
		await fleet.state.expire(key, ttl);
		const active = fleet.activeId() === "redis" ? redis : valkey;
		expect(await active.state.get(key)).toMatchObject({ value: "v" });
		await expect(fleet.close()).resolves.toBeUndefined();
		expect(valkey.close).toHaveBeenCalledOnce();
		expect(redis.close).toHaveBeenCalledOnce();
	});
});
