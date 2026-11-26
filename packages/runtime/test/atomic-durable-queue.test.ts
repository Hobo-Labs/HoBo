import { DURABLE_QUEUE_MAX_LIMITS, durableQueueOperation } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createAtomicDurableQueue,
	inspectAtomicDurableQueue,
	type AtomicQueueStore,
} from "../src/atomic-durable-queue.js";
import {
	ATOMIC_QUEUE_MAX_EVENTS,
	decodeAtomicQueueLog,
	encodeAtomicQueueLog,
} from "../src/atomic-queue-log.js";

const limits = {
	...DURABLE_QUEUE_MAX_LIMITS,
	nameBytes: 32,
	payloadBytes: 32,
	attributeCount: 2,
	attributeBytes: 16,
	batchSize: 2,
	leaseMs: 100,
	operationWindowMs: 20000,
	retainedMessages: 4,
	retainedReceipts: 20,
	deliveryAttempts: 2,
};
const op = (id: number) =>
	durableQueueOperation(10000, `abcdefghijklmn${String(id).padStart(2, "0")}`);
const message = (id: number, key = "job", data = [1]) => ({
	operation: op(id),
	message: {
		idempotencyKey: key,
		body: new Uint8Array(data),
		attributes: [{ key: "k", value: "v" }],
	},
});
function memoryStore() {
	let revision = 0;
	let bytes: Uint8Array | undefined;
	let lose = false;
	let calls = 0;
	const store: AtomicQueueStore = {
		async load() {
			return bytes === undefined
				? { status: "missing" }
				: { status: "available", revision, bytes: new Uint8Array(bytes) };
		},
		async compareAndSwap(expected, data) {
			calls++;
			if (expected !== revision) return { status: "unknown" };
			bytes = new Uint8Array(data);
			revision++;
			if (lose) {
				lose = false;
				return { status: "unknown" };
			}
			return { status: "committed" };
		},
	};
	return {
		store,
		loseNext: () => {
			lose = true;
		},
		calls: () => calls,
		corrupt: () => {
			bytes = new TextEncoder().encode("not-json");
			revision++;
		},
		advanceRevision: () => {
			revision++;
		},
		seed: (newRevision: number, data: Uint8Array) => {
			revision = newRevision;
			bytes = new Uint8Array(data);
		},
	};
}

describe("atomic durable queue provider", () => {
	it("attests only the exact factory-created queue and captured store", () => {
		const backing = memoryStore();
		const queue = createAtomicDurableQueue({
			store: backing.store,
			limits,
			now: () => 1000,
		});
		expect(inspectAtomicDurableQueue(queue)).toMatchObject({
			store: backing.store,
			limits,
		});
		const mutable = { store: backing.store, limits, now: () => 1000 };
		const captured = createAtomicDurableQueue(mutable);
		mutable.store = memoryStore().store;
		expect(inspectAtomicDurableQueue(captured)?.store).toBe(backing.store);
		expect(inspectAtomicDurableQueue({ ...queue })).toBeUndefined();
		let traps = 0;
		const proxy = new Proxy(queue, {
			get() {
				traps++;
				throw Error("trap");
			},
		});
		expect(inspectAtomicDurableQueue(proxy)).toBeUndefined();
		expect(traps).toBe(0);
		let getterCalls = 0;
		const options = {
			get store() {
				getterCalls++;
				return backing.store;
			},
			limits,
			now: () => 1000,
		};
		expect(() => createAtomicDurableQueue(options)).toThrow();
		expect(getterCalls).toBe(0);
		const iterator = Object.getOwnPropertyDescriptor(
			Array.prototype,
			Symbol.iterator,
		);
		let rejected = false;
		try {
			Object.defineProperty(Array.prototype, Symbol.iterator, {
				configurable: true,
				value: function* () {},
			});
			try {
				createAtomicDurableQueue(options);
			} catch {
				rejected = true;
			}
		} finally {
			if (iterator !== undefined)
				Object.defineProperty(Array.prototype, Symbol.iterator, iterator);
		}
		expect(rejected).toBe(true);
		expect(getterCalls).toBe(0);
	});

	it("recovers a committed enqueue after its response is lost and a new provider opens", async () => {
		const backing = memoryStore();
		backing.loseNext();
		const first = createAtomicDurableQueue({
			store: backing.store,
			limits,
			now: () => 1000,
		});
		expect(await first.enqueue(message(1))).toMatchObject({
			status: "unknown",
		});
		const reopened = createAtomicDurableQueue({
			store: backing.store,
			limits,
			now: () => 1001,
		});
		expect(await reopened.enqueue(message(1))).toEqual({
			status: "committed",
			value: { messageId: "m1", idempotencyKey: "job" },
		});
		expect(backing.calls()).toBe(1);
		expect(await reopened.enqueue(message(1, "job", [2]))).toEqual({
			status: "rejected",
			code: "operation-conflict",
		});
		const items = await reopened.dequeue({
			operation: op(2),
			maxMessages: 2,
			visibilityTimeoutMs: 10,
		});
		expect(items).toMatchObject({
			status: "committed",
			value: [{ messageId: "m1", leaseId: "l1" }],
		});
	});
	it("replays an unknown dequeue without leasing twice and fences an old lease", async () => {
		const backing = memoryStore();
		let clock = 1000;
		const queue = createAtomicDurableQueue({
			store: backing.store,
			limits,
			now: () => clock,
		});
		await queue.enqueue(message(1));
		backing.loseNext();
		const input = { operation: op(2), maxMessages: 1, visibilityTimeoutMs: 10 };
		expect(await queue.dequeue(input)).toMatchObject({ status: "unknown" });
		const reopened = createAtomicDurableQueue({
			store: backing.store,
			limits,
			now: () => clock,
		});
		expect(await reopened.dequeue(input)).toMatchObject({
			status: "committed",
			value: [{ leaseId: "l1", leaseExpiresAtMs: 1010 }],
		});
		clock = 1010;
		expect(
			await reopened.dequeue({ ...input, operation: op(3) }),
		).toMatchObject({ status: "committed", value: [{ leaseId: "l2" }] });
		expect(
			await reopened.complete({
				operation: op(4),
				messageId: "m1",
				leaseId: "l1",
			}),
		).toEqual({ status: "rejected", code: "lease-lost" });
		expect(
			await reopened.complete({
				operation: op(5),
				messageId: "m1",
				leaseId: "l2",
			}),
		).toMatchObject({ status: "committed" });
	});
	it("makes concurrent compare-and-swap losers unknown and safe to retry", async () => {
		const backing = memoryStore();
		const queue = createAtomicDurableQueue({
			store: backing.store,
			limits,
			now: () => 1000,
		});
		const results = await Promise.all([
			queue.enqueue(message(1, "a")),
			queue.enqueue(message(2, "b")),
		]);
		expect(
			results.filter((result) => result.status === "committed"),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.status === "unknown"),
		).toHaveLength(1);
		const failed =
			results[0]?.status === "unknown" ? message(1, "a") : message(2, "b");
		expect(await queue.enqueue(failed)).toMatchObject({ status: "committed" });
		const read = await queue.dequeue({
			operation: op(3),
			maxMessages: 2,
			visibilityTimeoutMs: 10,
		});
		if (read.status !== "committed") throw Error("expected deliveries");
		expect(read.value).toHaveLength(2);
	});
	it("refuses corrupt state, mismatched limits and clock regressions", async () => {
		const backing = memoryStore();
		const queue = createAtomicDurableQueue({
			store: backing.store,
			limits,
			now: () => 1000,
		});
		await queue.enqueue(message(1));
		backing.advanceRevision();
		expect(await queue.enqueue(message(2))).toMatchObject({
			status: "unknown",
		});
		const restored = memoryStore();
		const fresh = createAtomicDurableQueue({
			store: restored.store,
			limits,
			now: () => 1000,
		});
		await fresh.enqueue(message(1));
		const mismatch = createAtomicDurableQueue({
			store: restored.store,
			limits: { ...limits, batchSize: 1 },
			now: () => 1000,
		});
		expect(await mismatch.enqueue(message(2))).toMatchObject({
			status: "unknown",
		});
		const rewind = createAtomicDurableQueue({
			store: restored.store,
			limits,
			now: () => 999,
		});
		expect(await rewind.enqueue(message(2))).toMatchObject({
			status: "unknown",
		});
		restored.corrupt();
		expect(await fresh.enqueue(message(2))).toMatchObject({
			status: "unknown",
		});
	});
	it("compacts and reopens without losing unexpired receipts or leases", async () => {
		const backing = memoryStore();
		let clock = 1000;
		const queue = createAtomicDurableQueue({
			store: backing.store,
			limits,
			now: () => clock,
		});
		const initial = await queue.enqueue(message(1));
		const read = { operation: op(2), maxMessages: 1, visibilityTimeoutMs: 10 };
		const lease = await queue.dequeue(read);
		clock = 1005;
		expect(await queue.compact()).toEqual({
			status: "compacted",
			prunedReceipts: 0,
		});
		const reopened = createAtomicDurableQueue({
			store: backing.store,
			limits,
			now: () => clock,
		});
		const writes = backing.calls();
		expect(await reopened.enqueue(message(1))).toEqual(initial);
		expect(await reopened.dequeue(read)).toEqual(lease);
		expect(backing.calls()).toBe(writes);
		clock = 1010;
		expect(await reopened.dequeue({ ...read, operation: op(3) })).toMatchObject(
			{ status: "committed", value: [{ leaseId: "l2" }] },
		);
		expect(
			await reopened.complete({
				operation: op(4),
				messageId: "m1",
				leaseId: "l1",
			}),
		).toEqual({ status: "rejected", code: "lease-lost" });
	});
	it("reclaims completed messages only after their live receipts expire", async () => {
		const backing = memoryStore();
		let clock = 1000;
		const bounds = { ...limits, retainedMessages: 1 };
		const queue = createAtomicDurableQueue({
			store: backing.store,
			limits: bounds,
			now: () => clock,
		});
		const initial = await queue.enqueue(message(1));
		const read = { operation: op(2), maxMessages: 1, visibilityTimeoutMs: 10 };
		const leased = await queue.dequeue(read);
		const completed = { operation: op(3), messageId: "m1", leaseId: "l1" };
		expect(await queue.complete(completed)).toMatchObject({
			status: "committed",
		});
		expect(await queue.reclaimCompleted()).toEqual({
			status: "reclaimed",
			reclaimedMessages: 0,
			prunedReceipts: 0,
		});
		expect(await queue.enqueue(message(1))).toEqual(initial);
		expect(await queue.dequeue(read)).toEqual(leased);
		clock = 10000;
		backing.loseNext();
		expect(await queue.reclaimCompleted()).toEqual({ status: "unknown" });
		const reopened = createAtomicDurableQueue({
			store: backing.store,
			limits: bounds,
			now: () => clock,
		});
		expect(await reopened.reclaimCompleted()).toEqual({
			status: "reclaimed",
			reclaimedMessages: 0,
			prunedReceipts: 0,
		});
		const next = {
			...message(4),
			operation: durableQueueOperation(20000, "abcdefghijklmn04"),
		};
		expect(await reopened.enqueue(next)).toMatchObject({
			status: "committed",
			value: { messageId: "m2", idempotencyKey: "job" },
		});
	});
	it("retains a completed message while a later delivery receipt remains live", async () => {
		const backing = memoryStore();
		let clock = 1000;
		const queue = createAtomicDurableQueue({
			store: backing.store,
			limits,
			now: () => clock,
		});
		const early = (n: number) =>
			durableQueueOperation(
				2000,
				`abcdefghijklmn${String(n).padStart(2, "0")}`,
			);
		const later = durableQueueOperation(5000, "abcdefghijklmn09");
		await queue.enqueue({ ...message(1), operation: early(1) });
		const read = { operation: later, maxMessages: 1, visibilityTimeoutMs: 10 };
		const delivered = await queue.dequeue(read);
		await queue.complete({
			operation: early(3),
			messageId: "m1",
			leaseId: "l1",
		});
		clock = 2000;
		expect(await queue.reclaimCompleted()).toMatchObject({
			status: "reclaimed",
			reclaimedMessages: 0,
		});
		expect(await queue.dequeue(read)).toEqual(delivered);
		clock = 5000;
		expect(await queue.reclaimCompleted()).toMatchObject({
			status: "reclaimed",
			reclaimedMessages: 1,
		});
	});
	it("never reclaims an exhausted uncompleted message", async () => {
		const backing = memoryStore();
		let clock = 1000;
		const queue = createAtomicDurableQueue({
			store: backing.store,
			limits: { ...limits, deliveryAttempts: 1 },
			now: () => clock,
		});
		await queue.enqueue(message(1));
		await queue.dequeue({
			operation: op(2),
			maxMessages: 1,
			visibilityTimeoutMs: 10,
		});
		clock = 10000;
		expect(await queue.reclaimCompleted()).toMatchObject({
			status: "reclaimed",
			reclaimedMessages: 0,
		});
		expect(
			await queue.dequeue({
				operation: durableQueueOperation(20000, "abcdefghijklmn03"),
				maxMessages: 1,
				visibilityTimeoutMs: 10,
			}),
		).toEqual({ status: "rejected", code: "delivery-exhausted" });
	});

	it("lists bounded exhausted messages without exposing active leases or mutable storage", async () => {
		const backing = memoryStore();
		let clock = 1000;
		const bounds = { ...limits, batchSize: 1, deliveryAttempts: 1 };
		const queue = createAtomicDurableQueue({
			store: backing.store,
			limits: bounds,
			now: () => clock,
		});
		await queue.enqueue(message(1, "one", [1]));
		await queue.enqueue(message(2, "two", [2]));
		await queue.dequeue({
			operation: op(3),
			maxMessages: 1,
			visibilityTimeoutMs: 10,
		});
		await queue.dequeue({
			operation: op(4),
			maxMessages: 1,
			visibilityTimeoutMs: 10,
		});
		const writes = backing.calls();
		expect(await queue.inspectExhausted()).toMatchObject({
			status: "available",
			messages: [],
			more: false,
		});
		clock = 1010;
		const first = await queue.inspectExhausted();
		expect(first).toMatchObject({
			status: "available",
			observedAtMs: 1010,
			messages: [{ messageId: "m1", body: new Uint8Array([1]) }],
			more: true,
		});
		if (first.status !== "available" || !first.messages[0])
			throw Error("missing exhausted message");
		first.messages[0].body[0] = 99;
		expect(await queue.inspectExhausted()).toMatchObject({
			status: "available",
			messages: [{ messageId: "m1", body: new Uint8Array([1]) }],
		});
		expect(backing.calls()).toBe(writes);
		clock = 10000;
		expect(
			await queue.redriveExhausted({
				operation: durableQueueOperation(20000, "abcdefghijklmn05"),
				messageId: "m1",
			}),
		).toMatchObject({ status: "committed" });
		expect(await queue.inspectExhausted()).toMatchObject({
			status: "available",
			messages: [{ messageId: "m2" }],
			more: false,
		});
		backing.corrupt();
		expect(await queue.inspectExhausted()).toEqual({ status: "unknown" });
	});

	it("withholds exhausted payloads if read authorization is revoked before disclosure", async () => {
		const backing = memoryStore();
		let authorized = true;
		let clock = 1000;
		let revokeOnClock = false;
		const store: AtomicQueueStore = {
			load: () =>
				authorized
					? backing.store.load()
					: Promise.resolve({ status: "unavailable" }),
			compareAndSwap: backing.store.compareAndSwap,
		};
		const queue = createAtomicDurableQueue({
			store,
			limits: { ...limits, deliveryAttempts: 1 },
			now: () => {
				if (revokeOnClock) authorized = false;
				return clock;
			},
		});
		await queue.enqueue(message(1));
		await queue.dequeue({
			operation: op(2),
			maxMessages: 1,
			visibilityTimeoutMs: 1,
		});
		clock = 1010;
		expect(await queue.inspectExhausted()).toMatchObject({
			status: "available",
			messages: [{ messageId: "m1" }],
		});
		revokeOnClock = true;
		expect(await queue.inspectExhausted()).toEqual({ status: "unknown" });
	});

	it("reports unknown if the queue changes before an inspection is disclosed", async () => {
		const backing = memoryStore();
		let clock = 1000;
		let mutateOnNextLoad = false;
		const writer = createAtomicDurableQueue({
			store: backing.store,
			limits: { ...limits, deliveryAttempts: 1 },
			now: () => clock,
		});
		const observing: AtomicQueueStore = {
			async load() {
				if (mutateOnNextLoad) {
					mutateOnNextLoad = false;
					await writer.enqueue(message(3, "other"));
				}
				return backing.store.load();
			},
			compareAndSwap: backing.store.compareAndSwap,
		};
		const observer = createAtomicDurableQueue({
			store: observing,
			limits: { ...limits, deliveryAttempts: 1 },
			now: () => {
				mutateOnNextLoad = true;
				return clock;
			},
		});
		await writer.enqueue(message(1));
		await writer.dequeue({
			operation: op(2),
			maxMessages: 1,
			visibilityTimeoutMs: 1,
		});
		clock = 1010;
		expect(await observer.inspectExhausted()).toEqual({ status: "unknown" });
	});

	it("confirms a durable export once and preserves its receipt across reopening", async () => {
		const backing = memoryStore();
		let clock = 1000;
		const bounds = { ...limits, deliveryAttempts: 1 };
		const queue = createAtomicDurableQueue({
			store: backing.store,
			limits: bounds,
			now: () => clock,
		});
		await queue.enqueue(message(1));
		await queue.dequeue({
			operation: op(2),
			maxMessages: 1,
			visibilityTimeoutMs: 10,
		});
		clock = 10000;
		const snapshot = await queue.inspectExhausted();
		if (snapshot.status !== "available") throw Error("inspection unavailable");
		const request = {
			operation: durableQueueOperation(20000, "abcdefghijklmn03"),
			messageId: "m1",
			expectedRevision: snapshot.revision,
			exportReceipt: "destination-receipt",
		};
		backing.loseNext();
		expect(await queue.confirmExhaustedExport(request)).toMatchObject({
			status: "unknown",
			operation: request.operation,
		});
		const reopened = createAtomicDurableQueue({
			store: backing.store,
			limits: bounds,
			now: () => clock,
		});
		expect(await reopened.confirmExhaustedExport(request)).toMatchObject({
			status: "committed",
			value: { messageId: "m1" },
		});
		expect(
			await reopened.confirmExhaustedExport({
				...request,
				exportReceipt: "other-receipt",
			}),
		).toEqual({ status: "rejected", code: "operation-conflict" });
		expect(
			await reopened.confirmExhaustedExport({
				...request,
				expectedRevision: request.expectedRevision + 1,
			}),
		).toEqual({ status: "rejected", code: "operation-conflict" });
		expect(await reopened.inspectExhausted()).toMatchObject({
			status: "available",
			messages: [],
		});
		expect(await reopened.compact()).toMatchObject({ status: "compacted" });
		const afterCheckpoint = createAtomicDurableQueue({
			store: backing.store,
			limits: bounds,
			now: () => clock,
		});
		expect(await afterCheckpoint.confirmExhaustedExport(request)).toMatchObject(
			{ status: "committed" },
		);
		expect(await afterCheckpoint.reclaimCompleted()).toMatchObject({
			status: "reclaimed",
			reclaimedMessages: 0,
		});
		clock = 20000;
		expect(await afterCheckpoint.reclaimCompleted()).toMatchObject({
			status: "reclaimed",
			reclaimedMessages: 1,
		});
	});
	it("rejects a stored export confirmation with a forged historical revision", async () => {
		const backing = memoryStore();
		const bounds = { ...limits, deliveryAttempts: 1 };
		const events = [
			{ atMs: 1000, request: { kind: "enqueue" as const, input: message(1) } },
			{
				atMs: 1000,
				request: {
					kind: "dequeue" as const,
					input: { operation: op(2), maxMessages: 1, visibilityTimeoutMs: 10 },
				},
			},
			{
				atMs: 10000,
				request: {
					kind: "confirmExport" as const,
					input: {
						operation: durableQueueOperation(20000, "abcdefghijklmn03"),
						messageId: "m1",
						expectedRevision: 4,
						exportReceipt: "destination-receipt",
					},
				},
			},
		];
		backing.seed(events.length, encodeAtomicQueueLog(events, bounds));
		const queue = createAtomicDurableQueue({
			store: backing.store,
			limits: bounds,
			now: () => 10000,
		});
		expect(await queue.inspectExhausted()).toEqual({ status: "unknown" });
	});

	it("does not confirm an export using a stale inspection", async () => {
		const backing = memoryStore();
		let clock = 1000;
		const queue = createAtomicDurableQueue({
			store: backing.store,
			limits: { ...limits, deliveryAttempts: 1 },
			now: () => clock,
		});
		await queue.enqueue(message(1));
		await queue.dequeue({
			operation: op(2),
			maxMessages: 1,
			visibilityTimeoutMs: 10,
		});
		clock = 10000;
		const snapshot = await queue.inspectExhausted();
		if (snapshot.status !== "available") throw Error("inspection unavailable");
		await queue.enqueue({
			...message(3, "other"),
			operation: durableQueueOperation(20000, "abcdefghijklmn03"),
		});
		const request = {
			operation: durableQueueOperation(20000, "abcdefghijklmn04"),
			messageId: "m1",
			expectedRevision: snapshot.revision,
			exportReceipt: "destination-receipt",
		};
		expect(await queue.confirmExhaustedExport(request)).toMatchObject({
			status: "unknown",
			operation: request.operation,
		});
		expect(await queue.inspectExhausted()).toMatchObject({
			status: "available",
			messages: [{ messageId: "m1" }],
		});
	});

	it("redrives an exhausted message once and safely replays a lost response", async () => {
		const backing = memoryStore();
		let clock = 1000;
		const bounds = { ...limits, deliveryAttempts: 1 };
		const queue = createAtomicDurableQueue({
			store: backing.store,
			limits: bounds,
			now: () => clock,
		});
		await queue.enqueue(message(1));
		await queue.dequeue({
			operation: op(2),
			maxMessages: 1,
			visibilityTimeoutMs: 10,
		});
		clock = 1010;
		const early = { operation: op(3), messageId: "m1" };
		expect(await queue.redriveExhausted(early)).toEqual({
			status: "rejected",
			code: "unavailable",
		});
		clock = 10000;
		const request = {
			operation: durableQueueOperation(20000, "abcdefghijklmn04"),
			messageId: "m1",
		};
		backing.loseNext();
		expect(await queue.redriveExhausted(request)).toMatchObject({
			status: "unknown",
			operation: request.operation,
		});
		const reopened = createAtomicDurableQueue({
			store: backing.store,
			limits: bounds,
			now: () => clock,
		});
		expect(await reopened.redriveExhausted(request)).toEqual({
			status: "committed",
			value: { messageId: "m1", idempotencyKey: "job" },
		});
		const read = {
			operation: durableQueueOperation(20000, "abcdefghijklmn05"),
			maxMessages: 1,
			visibilityTimeoutMs: 10,
		};
		expect(await reopened.dequeue(read)).toMatchObject({
			status: "committed",
			value: [{ messageId: "m1", leaseId: "l2", deliveryAttempt: 1 }],
		});
		expect(await reopened.redriveExhausted(request)).toMatchObject({
			status: "committed",
		});
		expect(
			await reopened.redriveExhausted({ ...request, messageId: "m2" }),
		).toEqual({ status: "rejected", code: "operation-conflict" });
		expect(await reopened.compact()).toMatchObject({ status: "compacted" });
		const recovered = createAtomicDurableQueue({
			store: backing.store,
			limits: bounds,
			now: () => clock,
		});
		expect(await recovered.redriveExhausted(request)).toMatchObject({
			status: "committed",
		});
		clock = 10010;
		expect(
			await recovered.dequeue({
				...read,
				operation: durableQueueOperation(20000, "abcdefghijklmn06"),
			}),
		).toEqual({ status: "rejected", code: "delivery-exhausted" });
	});
	it("commits at most one of two concurrent redrives using the same operation", async () => {
		const backing = memoryStore();
		let clock = 1000;
		const queue = createAtomicDurableQueue({
			store: backing.store,
			limits: { ...limits, deliveryAttempts: 1 },
			now: () => clock,
		});
		await queue.enqueue(message(1));
		await queue.dequeue({
			operation: op(2),
			maxMessages: 1,
			visibilityTimeoutMs: 10,
		});
		clock = 10000;
		const request = {
			operation: durableQueueOperation(20000, "abcdefghijklmn03"),
			messageId: "m1",
		};
		const results = await Promise.all([
			queue.redriveExhausted(request),
			queue.redriveExhausted(request),
		]);
		expect(results.map((result) => result.status).sort()).toEqual([
			"committed",
			"unknown",
		]);
		expect(await queue.redriveExhausted(request)).toMatchObject({
			status: "committed",
		});
		expect(
			await queue.dequeue({
				operation: durableQueueOperation(20000, "abcdefghijklmn04"),
				maxMessages: 1,
				visibilityTimeoutMs: 10,
			}),
		).toMatchObject({
			status: "committed",
			value: [{ leaseId: "l2", deliveryAttempt: 1 }],
		});
	});

	it("does not redrive an active lease even after all receipts expire", async () => {
		const backing = memoryStore();
		let clock = 1000;
		const queue = createAtomicDurableQueue({
			store: backing.store,
			limits: { ...limits, deliveryAttempts: 1 },
			now: () => clock,
		});
		const short = (nonce: string) => durableQueueOperation(1001, nonce);
		await queue.enqueue({
			...message(1),
			operation: short("abcdefghijklmn01"),
		});
		await queue.dequeue({
			operation: short("abcdefghijklmn02"),
			maxMessages: 1,
			visibilityTimeoutMs: 100,
		});
		clock = 1001;
		expect(
			await queue.redriveExhausted({
				operation: durableQueueOperation(2000, "abcdefghijklmn03"),
				messageId: "m1",
			}),
		).toEqual({ status: "rejected", code: "unavailable" });
		clock = 1100;
		expect(
			await queue.redriveExhausted({
				operation: durableQueueOperation(2000, "abcdefghijklmn04"),
				messageId: "m1",
			}),
		).toMatchObject({ status: "committed" });
	});

	it("redrives a released final delivery after its receipts expire", async () => {
		const backing = memoryStore();
		let clock = 1000;
		const queue = createAtomicDurableQueue({
			store: backing.store,
			limits: { ...limits, deliveryAttempts: 1 },
			now: () => clock,
		});
		await queue.enqueue(message(1));
		await queue.dequeue({
			operation: op(2),
			maxMessages: 1,
			visibilityTimeoutMs: 10,
		});
		await queue.release({ operation: op(3), messageId: "m1", leaseId: "l1" });
		clock = 10000;
		expect(
			await queue.redriveExhausted({
				operation: durableQueueOperation(20000, "abcdefghijklmn04"),
				messageId: "m1",
			}),
		).toMatchObject({ status: "committed" });
	});

	it("fences reclamation against a concurrent new receipt", async () => {
		const backing = memoryStore();
		let clock = 1000;
		const queue = createAtomicDurableQueue({
			store: backing.store,
			limits,
			now: () => clock,
		});
		await queue.enqueue(message(1));
		await queue.dequeue({
			operation: op(2),
			maxMessages: 1,
			visibilityTimeoutMs: 10,
		});
		await queue.complete({ operation: op(3), messageId: "m1", leaseId: "l1" });
		clock = 10000;
		const next = {
			...message(4),
			operation: durableQueueOperation(20000, "abcdefghijklmn04"),
		};
		const [reclaimed, duplicate] = await Promise.all([
			queue.reclaimCompleted(),
			queue.enqueue(next),
		]);
		expect(
			[reclaimed.status, duplicate.status].filter(
				(status) => status === "unknown",
			),
		).toHaveLength(1);
		const retry = await queue.enqueue(next);
		expect(retry.status).toBe("committed");
		if (duplicate.status === "committed") expect(retry).toEqual(duplicate);
	});

	it("recovers a lost compaction response without losing a receipt", async () => {
		const backing = memoryStore();
		const queue = createAtomicDurableQueue({
			store: backing.store,
			limits,
			now: () => 1000,
		});
		const accepted = await queue.enqueue(message(1));
		backing.loseNext();
		expect(await queue.compact()).toEqual({ status: "unknown" });
		const reopened = createAtomicDurableQueue({
			store: backing.store,
			limits,
			now: () => 1000,
		});
		expect(await reopened.enqueue(message(1))).toEqual(accepted);
		expect(await reopened.compact()).toEqual({
			status: "compacted",
			prunedReceipts: 0,
		});
	});
	it("fences a compaction competing with an enqueue", async () => {
		const backing = memoryStore();
		const queue = createAtomicDurableQueue({
			store: backing.store,
			limits,
			now: () => 1000,
		});
		await queue.enqueue(message(1));
		const [compacted, added] = await Promise.all([
			queue.compact(),
			queue.enqueue(message(2, "other")),
		]);
		expect(
			[compacted.status, added.status].filter((status) => status === "unknown"),
		).toHaveLength(1);
		if (added.status === "unknown")
			expect(await queue.enqueue(message(2, "other"))).toMatchObject({
				status: "committed",
			});
		else expect(await queue.compact()).toMatchObject({ status: "compacted" });
		const delivery = await queue.dequeue({
			operation: op(3),
			maxMessages: 2,
			visibilityTimeoutMs: 10,
		});
		if (delivery.status !== "committed") throw Error("expected delivery");
		expect(delivery.value).toHaveLength(2);
	});
	it("reclaims a full event segment while keeping the log bounded", async () => {
		const backing = memoryStore();
		const bounds = { ...limits, retainedReceipts: 600 };
		const events = Array.from(
			{ length: ATOMIC_QUEUE_MAX_EVENTS },
			(_, index) => ({
				atMs: 1000,
				request: {
					kind: "dequeue" as const,
					input: {
						operation: durableQueueOperation(
							1001,
							String(index).padStart(16, "0"),
						),
						maxMessages: 1,
						visibilityTimeoutMs: 10,
					},
				},
			}),
		);
		backing.seed(events.length, encodeAtomicQueueLog(events, bounds));
		const queue = createAtomicDurableQueue({
			store: backing.store,
			limits: bounds,
			now: () => 1001,
		});
		expect(await queue.enqueue(message(1))).toMatchObject({
			status: "unknown",
		});
		expect(await queue.compact()).toEqual({
			status: "compacted",
			prunedReceipts: ATOMIC_QUEUE_MAX_EVENTS,
		});
		expect(await queue.enqueue(message(1))).toMatchObject({
			status: "committed",
		});
	});

	it("does not let modified UTF-8 helpers forge the durable log", () => {
		const event = {
			atMs: 1000,
			request: { kind: "enqueue" as const, input: message(1) },
		};
		const encode = Object.getOwnPropertyDescriptor(
			TextEncoder.prototype,
			"encode",
		);
		const decode = Object.getOwnPropertyDescriptor(
			TextDecoder.prototype,
			"decode",
		);
		let parsed: ReturnType<typeof decodeAtomicQueueLog>;
		try {
			Object.defineProperty(TextEncoder.prototype, "encode", {
				configurable: true,
				value: () => new Uint8Array([0]),
			});
			Object.defineProperty(TextDecoder.prototype, "decode", {
				configurable: true,
				value: () => "[]",
			});
			parsed = decodeAtomicQueueLog(
				encodeAtomicQueueLog([event], limits),
				limits,
			);
		} finally {
			if (encode !== undefined)
				Object.defineProperty(TextEncoder.prototype, "encode", encode);
			if (decode !== undefined)
				Object.defineProperty(TextDecoder.prototype, "decode", decode);
		}
		expect(parsed.events).toEqual([event]);
	});

	it("bounds log length, rejects noncanonical data, and pins limits", () => {
		const event = {
			atMs: 1000,
			request: { kind: "enqueue" as const, input: message(1) },
		};
		const log = encodeAtomicQueueLog([event], limits);
		expect(decodeAtomicQueueLog(log, limits).events).toEqual([event]);
		expect(() =>
			decodeAtomicQueueLog(log, { ...limits, batchSize: 1 }),
		).toThrow();
		expect(() =>
			decodeAtomicQueueLog(
				new TextEncoder().encode('[1,[],[["e",0,"x",1,"a","%%%",[],null]]]'),
				limits,
			),
		).toThrow();
		expect(() =>
			encodeAtomicQueueLog(
				Array(ATOMIC_QUEUE_MAX_EVENTS + 1).fill(event),
				limits,
			),
		).toThrow();
	});
});
