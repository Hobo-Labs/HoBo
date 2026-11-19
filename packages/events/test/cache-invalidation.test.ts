import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCacheClient, type EventInput } from "@hobo/core";
import { createMemoryEphemeralState } from "@hobo/kv-redis-compatible";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { describe, expect, it } from "vitest";
import { subscribeCacheInvalidation } from "../src/cache-invalidation.js";
import { createDataChangedEvent } from "../src/events.js";

const context = {
	tenant: "shop",
	actor: { kind: "service", id: "writer" },
} as const;
function change(key: string): EventInput {
	const fact = createDataChangedEvent({
		resource: "users",
		key,
		op: "update",
		sourceSeq: 1,
	});
	return { type: fact.type, data: fact.data };
}

describe("data change facts", () => {
	it("carries optional replay data without changing the existing fact shape", () => {
		const base = {
			resource: "tickets",
			key: "a",
			op: "update" as const,
			sourceSeq: 2,
		};
		expect(createDataChangedEvent(base).data).toEqual(base);
		expect(
			createDataChangedEvent({
				...base,
				sourceStreamId: "ticket:a",
				rowJson: '{"id":"a"}',
			}).data,
		).toEqual({ ...base, sourceStreamId: "ticket:a", rowJson: '{"id":"a"}' });
	});
});

describe("cache invalidation from data changes", () => {
	it("invalidates selected tags after a real event-store delivery", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-cache-events-"));
		const store = createRuntimeLocalEventStore({ dataDir: directory });
		const cache = createCacheClient(createMemoryEphemeralState(), "shop");
		let delivered = () => {
			throw new Error("delivery was not initialized");
		};
		const observed = new Promise<void>((resolve) => {
			delivered = resolve;
		});
		const wrapped = {
			...cache,
			async invalidate(tag: string) {
				await cache.invalidate(tag);
				delivered();
			},
		};
		const connection = subscribeCacheInvalidation(store, wrapped, (event) => {
			expect(event.type).toBe("data.Changed");
			return ["users", "users"];
		});
		try {
			await connection.ready;
			await cache.set("user:1", Uint8Array.from([1]), 1000, ["users"]);
			await cache.set("product:1", Uint8Array.from([2]), 1000, ["products"]);
			await store.append("users", [change("1")], {
				...context,
				expectedSeq: 0,
			});
			await observed;
			await connection.drain();
			expect(await cache.get("user:1")).toBeUndefined();
			expect(await cache.get("product:1")).toEqual(Uint8Array.from([2]));
		} finally {
			connection.unsubscribe();
			await connection.drain();
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("reports failed invalidations and continues processing later changes", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-cache-events-"));
		const store = createRuntimeLocalEventStore({ dataDir: directory });
		const cache = createCacheClient(createMemoryEphemeralState(), "shop");
		let delivered = () => {
			throw new Error("delivery was not initialized");
		};
		let observed = new Promise<void>((resolve) => {
			delivered = resolve;
		});
		let calls = 0;
		const connection = subscribeCacheInvalidation(store, cache, () => {
			calls++;
			delivered();
			return calls === 1 ? [""] : ["users"];
		});
		try {
			await connection.ready;
			await cache.set("user:1", Uint8Array.from([1]), 1000, ["users"]);
			await store.append("users", [change("1")], {
				...context,
				expectedSeq: 0,
			});
			await observed;
			await expect(connection.drain()).rejects.toThrow(
				"cache invalidation failed",
			);
			expect(await cache.get("user:1")).toEqual(Uint8Array.from([1]));
			observed = new Promise<void>((resolve) => {
				delivered = resolve;
			});
			await store.append("users", [change("1")], {
				...context,
				expectedSeq: 1,
			});
			await observed;
			await connection.drain();
			expect(await cache.get("user:1")).toBeUndefined();
		} finally {
			connection.unsubscribe();
			await connection.drain();
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("replays missed changes while buffering and deduplicating live delivery", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-cache-events-"));
		const store = createRuntimeLocalEventStore({ dataDir: directory });
		const cache = createCacheClient(createMemoryEphemeralState(), "shop");
		let release = () => {
			throw new Error("replay was not started");
		};
		let started = () => {
			throw new Error("replay was not started");
		};
		let delivered = () => {
			throw new Error("delivery was not initialized");
		};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const replayStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const liveDelivered = new Promise<void>((resolve) => {
			delivered = resolve;
		});
		const observed: number[] = [];
		await store.append("users", [change("1")], { ...context, expectedSeq: 0 });
		await cache.set("user:1", Uint8Array.from([1]), 1000, ["users"]);
		const monitored = {
			...store,
			subscribe(
				filter: Parameters<typeof store.subscribe>[0],
				handler: Parameters<typeof store.subscribe>[1],
			) {
				return store.subscribe(filter, (event) => {
					const result = handler(event);
					if (event.seq === 2) delivered();
					return result;
				});
			},
		};
		const connection = subscribeCacheInvalidation(
			monitored,
			cache,
			async (event) => {
				observed.push(event.seq);
				if (event.seq === 1) {
					started();
					await gate;
				}
				return ["users"];
			},
			{ replayStreams: ["users"] },
		);
		try {
			await replayStarted;
			await store.append("users", [change("1")], {
				...context,
				expectedSeq: 1,
			});
			await liveDelivered;
			release();
			await connection.ready;
			expect(observed).toEqual([1, 2]);
			expect(await cache.get("user:1")).toBeUndefined();
		} finally {
			connection.unsubscribe();
			await connection.drain();
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("fails startup if the replay buffer cannot hold live changes", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-cache-events-"));
		const store = createRuntimeLocalEventStore({ dataDir: directory });
		const cache = createCacheClient(createMemoryEphemeralState(), "shop");
		let release = () => {
			throw new Error("replay was not started");
		};
		let started = () => {
			throw new Error("replay was not started");
		};
		let delivered = () => {
			throw new Error("delivery was not initialized");
		};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const replayStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const liveDelivered = new Promise<void>((resolve) => {
			delivered = resolve;
		});
		await store.append("users", [change("1")], { ...context, expectedSeq: 0 });
		const monitored = {
			...store,
			subscribe(
				filter: Parameters<typeof store.subscribe>[0],
				handler: Parameters<typeof store.subscribe>[1],
			) {
				return store.subscribe(filter, (event) => {
					const result = handler(event);
					if (event.seq === 3) delivered();
					return result;
				});
			},
		};
		const connection = subscribeCacheInvalidation(
			monitored,
			cache,
			async (event) => {
				if (event.seq === 1) {
					started();
					await gate;
				}
				return ["users"];
			},
			{ replayStreams: ["users"], maxBufferedEvents: 1 },
		);
		try {
			await replayStarted;
			await store.append("users", [change("2")], {
				...context,
				expectedSeq: 1,
			});
			await store.append("users", [change("3")], {
				...context,
				expectedSeq: 2,
			});
			await liveDelivered;
			const failure = expect(connection.ready).rejects.toThrow(
				/buffer exceeded/u,
			);
			release();
			await failure;
		} finally {
			connection.unsubscribe();
			await connection.drain();
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
