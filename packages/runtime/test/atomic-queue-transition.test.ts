import { DURABLE_QUEUE_MAX_LIMITS, durableQueueOperation } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	emptyAtomicQueueState,
	transitionAtomicQueue,
	type AtomicQueueRequest,
	type AtomicQueueState,
} from "../src/atomic-queue-transition.js";

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
const op = (id: number, expires = 10000) =>
	durableQueueOperation(
		expires,
		`abcdefghijklmn${String(id).padStart(2, "0")}`,
	);
const enqueue = (id: number, key = "job", body = [1]): AtomicQueueRequest => ({
	kind: "enqueue",
	input: {
		operation: op(id),
		message: {
			idempotencyKey: key,
			body: new Uint8Array(body),
			attributes: [{ key: "k", value: "v" }],
		},
	},
});
const dequeue = (id: number): AtomicQueueRequest => ({
	kind: "dequeue",
	input: { operation: op(id), maxMessages: 1, visibilityTimeoutMs: 10 },
});
function apply(
	state: AtomicQueueState,
	request: AtomicQueueRequest,
	now = 1000,
	bounds = limits,
) {
	return transitionAtomicQueue(state, request, now, bounds);
}

describe("bounded atomic queue transitions", () => {
	it("pins operations, replays receipts and rejects distinct requests", () => {
		const first = apply(emptyAtomicQueueState(), enqueue(1));
		expect(first.outcome).toEqual({
			status: "committed",
			value: { messageId: "m1", idempotencyKey: "job" },
		});
		const replay = apply(first.state, enqueue(1));
		expect(replay.changed).toBe(false);
		expect(replay.outcome).toEqual(first.outcome);
		expect(apply(first.state, enqueue(1, "job", [2])).outcome).toEqual({
			status: "rejected",
			code: "operation-conflict",
		});
		const dedup = apply(first.state, enqueue(2));
		expect(dedup.outcome).toEqual(first.outcome);
		expect(dedup.state.messages).toHaveLength(1);
		expect(apply(dedup.state, enqueue(3, "job", [3])).outcome).toEqual({
			status: "rejected",
			code: "message-conflict",
		});
	});
	it("replays the original lease without letting returned buffers mutate its receipt", () => {
		const added = apply(emptyAtomicQueueState(), enqueue(1));
		const leased = apply(added.state, dequeue(2));
		if (
			leased.outcome.status !== "committed" ||
			!Array.isArray(leased.outcome.value)
		)
			throw Error("missing lease");
		const first = leased.outcome.value[0];
		if (first === undefined) throw Error("missing delivery");
		first.body[0] = 9;
		const replay = apply(leased.state, dequeue(2), 1005);
		expect(replay.changed).toBe(false);
		expect(replay.outcome).toMatchObject({
			status: "committed",
			value: [
				{ leaseId: "l1", leaseExpiresAtMs: 1010, body: new Uint8Array([1]) },
			],
		});
	});
	it("fences stale leases after redelivery and replays completion", () => {
		const added = apply(emptyAtomicQueueState(), enqueue(1));
		const first = apply(added.state, dequeue(2));
		const second = apply(first.state, dequeue(3), 1010);
		expect(second.outcome).toMatchObject({
			status: "committed",
			value: [{ messageId: "m1", leaseId: "l2", deliveryAttempt: 2 }],
		});
		const stale: AtomicQueueRequest = {
			kind: "complete",
			input: { operation: op(4), messageId: "m1", leaseId: "l1" },
		};
		const rejected = apply(second.state, stale, 1011);
		expect(rejected.outcome).toEqual({
			status: "rejected",
			code: "lease-lost",
		});
		const complete: AtomicQueueRequest = {
			kind: "complete",
			input: { operation: op(5), messageId: "m1", leaseId: "l2" },
		};
		const done = apply(rejected.state, complete, 1011);
		expect(done.outcome).toMatchObject({ status: "committed" });
		expect(apply(done.state, complete, 1012).outcome).toEqual(done.outcome);
		expect(apply(done.state, dequeue(6), 1020).outcome).toEqual({
			status: "committed",
			value: [],
		});
	});
	it("makes receipt exhaustion unknown until expired receipts can be reclaimed", () => {
		const bounds = { ...limits, retainedReceipts: 1 };
		const request: AtomicQueueRequest = {
			kind: "enqueue",
			input: {
				operation: op(1, 1001),
				message: {
					idempotencyKey: "a",
					body: new Uint8Array(),
					attributes: [],
				},
			},
		};
		const first = apply(emptyAtomicQueueState(), request, 1000, bounds);
		expect(apply(first.state, enqueue(2), 1000, bounds).outcome).toMatchObject({
			status: "unknown",
		});
		expect(apply(first.state, request, 1001, bounds).outcome).toMatchObject({
			status: "expired",
		});
		expect(apply(first.state, enqueue(2), 1001, bounds).outcome).toMatchObject({
			status: "committed",
		});
	});
	it("preserves request identity when array and JSON helpers change", () => {
		const input = enqueue(1);
		const first = apply(emptyAtomicQueueState(), input);
		const savedMap = Object.getOwnPropertyDescriptor(Array.prototype, "map");
		const savedFind = Object.getOwnPropertyDescriptor(Array.prototype, "find");
		const savedStringify = JSON.stringify;
		let replay: ReturnType<typeof apply>;
		try {
			Object.defineProperty(Array.prototype, "map", {
				configurable: true,
				value: () => [],
			});
			Object.defineProperty(Array.prototype, "find", {
				configurable: true,
				value: () => undefined,
			});
			JSON.stringify = () => "forged";
			replay = apply(first.state, input);
		} finally {
			if (savedMap !== undefined)
				Object.defineProperty(Array.prototype, "map", savedMap);
			if (savedFind !== undefined)
				Object.defineProperty(Array.prototype, "find", savedFind);
			JSON.stringify = savedStringify;
		}
		expect(replay.changed).toBe(false);
		expect(replay.outcome).toEqual(first.outcome);
	});
	it("returns capacity explicitly after message retention is full", () => {
		const bounds = { ...limits, retainedMessages: 1 };
		const first = apply(emptyAtomicQueueState(), enqueue(1), 1000, bounds);
		const second = apply(first.state, enqueue(2, "other"), 1000, bounds);
		expect(second.outcome).toEqual({
			status: "rejected",
			code: "capacity-exceeded",
		});
		expect(
			apply(second.state, enqueue(2, "other"), 1001, bounds).outcome,
		).toEqual(second.outcome);
	});

	it("records delayed-message and attempt-limit decisions", () => {
		const input: AtomicQueueRequest = {
			kind: "enqueue",
			input: {
				operation: op(1),
				message: {
					idempotencyKey: "job",
					body: new Uint8Array([1]),
					attributes: [],
					availableAtMs: 1005,
				},
			},
		};
		const added = apply(emptyAtomicQueueState(), input);
		const early = apply(added.state, dequeue(2));
		expect(early.outcome).toEqual({ status: "committed", value: [] });
		const first = apply(early.state, dequeue(3), 1005);
		const second = apply(first.state, dequeue(4), 1015);
		expect(apply(second.state, dequeue(5), 1025).outcome).toEqual({
			status: "rejected",
			code: "delivery-exhausted",
		});
	});
});
