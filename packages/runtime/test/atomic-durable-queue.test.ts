import { DURABLE_QUEUE_MAX_LIMITS, durableQueueOperation } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createAtomicDurableQueue,
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
	};
}

describe("atomic durable queue provider", () => {
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
		expect(parsed).toEqual([event]);
	});

	it("bounds log length, rejects noncanonical data, and pins limits", () => {
		const event = {
			atMs: 1000,
			request: { kind: "enqueue" as const, input: message(1) },
		};
		const log = encodeAtomicQueueLog([event], limits);
		expect(decodeAtomicQueueLog(log, limits)).toEqual([event]);
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
