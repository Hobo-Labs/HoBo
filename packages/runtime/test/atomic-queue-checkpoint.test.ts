import { DURABLE_QUEUE_MAX_LIMITS, durableQueueOperation } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	decodeAtomicQueueCheckpoint,
	encodeAtomicQueueCheckpoint,
} from "../src/atomic-queue-checkpoint.js";
import {
	type AtomicQueueRequest,
	emptyAtomicQueueState,
	transitionAtomicQueue,
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
function fixture() {
	const requests: AtomicQueueRequest[] = [
		{
			kind: "enqueue",
			input: {
				operation: op(1),
				message: {
					idempotencyKey: "job",
					body: new Uint8Array([1, 2]),
					attributes: [{ key: "k", value: "v" }],
				},
			},
		},
		{
			kind: "dequeue",
			input: { operation: op(2), maxMessages: 1, visibilityTimeoutMs: 10 },
		},
		{
			kind: "extendLease",
			input: {
				operation: op(3),
				messageId: "m1",
				leaseId: "l1",
				visibilityTimeoutMs: 20,
			},
		},
		{
			kind: "release",
			input: { operation: op(4, 1004), messageId: "m1", leaseId: "l1" },
		},
		{
			kind: "dequeue",
			input: { operation: op(5), maxMessages: 1, visibilityTimeoutMs: 10 },
		},
		{
			kind: "complete",
			input: { operation: op(6), messageId: "m1", leaseId: "l2" },
		},
		{
			kind: "complete",
			input: { operation: op(7, 1007), messageId: "m1", leaseId: "l1" },
		},
	];
	let state = emptyAtomicQueueState();
	for (let index = 0; index < requests.length; index++) {
		const request = requests[index];
		if (request === undefined) throw Error("missing request");
		const step = transitionAtomicQueue(state, request, 1000 + index, limits);
		if (!step.changed) throw Error("unchanged fixture");
		state = step.state;
	}
	return { state, requests };
}

describe("atomic queue checkpoint codec", () => {
	it("preserves live receipts, messages and lease generations while pruning expired receipts", () => {
		const { state, requests } = fixture();
		const encoded = encodeAtomicQueueCheckpoint(state, 1007, limits);
		const restored = decodeAtomicQueueCheckpoint(encoded, limits);
		expect(restored.atMs).toBe(1007);
		expect(restored.state.messages).toEqual(state.messages);
		expect(restored.state.nextLease).toBe(state.nextLease);
		expect(state.receipts).toHaveLength(6);
		expect(restored.state.receipts).toHaveLength(5);
		for (const request of requests) {
			if (request.input.operation.expiresAtMs <= 1007) continue;
			expect(
				transitionAtomicQueue(restored.state, request, 1007, limits).outcome,
			).toEqual(transitionAtomicQueue(state, request, 1007, limits).outcome);
		}
	});
	it("restores sparse monotonic message IDs without allowing live receipts to lose their message", () => {
		const { state } = fixture();
		const first = state.messages[0];
		if (!first) throw Error("missing message");
		const sparse = {
			...state,
			nextMessage: 4,
			messages: [{ ...first, messageId: "m3" }],
			receipts: [],
		};
		const restored = decodeAtomicQueueCheckpoint(
			encodeAtomicQueueCheckpoint(sparse, 10000, limits),
			limits,
		);
		expect(restored.state.messages[0]?.messageId).toBe("m3");
		const next = transitionAtomicQueue(
			restored.state,
			{
				kind: "enqueue",
				input: {
					operation: op(8, 20000),
					message: {
						idempotencyKey: "another",
						body: new Uint8Array([2]),
						attributes: [],
					},
				},
			},
			10000,
			limits,
		);
		expect(next.outcome).toMatchObject({
			status: "committed",
			value: { messageId: "m4" },
		});
		const missing = { ...state, messages: [] };
		expect(() =>
			decodeAtomicQueueCheckpoint(
				encodeAtomicQueueCheckpoint(missing, 1007, limits),
				limits,
			),
		).toThrow();
		const reversed = {
			...sparse,
			messages: [
				{ ...first, messageId: "m3" },
				{ ...first, messageId: "m2", idempotencyKey: "second" },
			],
		};
		expect(() =>
			decodeAtomicQueueCheckpoint(
				encodeAtomicQueueCheckpoint(reversed, 10000, limits),
				limits,
			),
		).toThrow();
	});

	it("copies original request data before it can change a receipt", () => {
		const request: AtomicQueueRequest = {
			kind: "enqueue",
			input: {
				operation: op(1),
				message: {
					idempotencyKey: "job",
					body: new Uint8Array([1]),
					attributes: [],
				},
			},
		};
		const state = transitionAtomicQueue(
			emptyAtomicQueueState(),
			request,
			1000,
			limits,
		).state;
		request.input.message.body[0] = 9;
		const restored = decodeAtomicQueueCheckpoint(
			encodeAtomicQueueCheckpoint(state, 1001, limits),
			limits,
		);
		expect(restored.state.messages[0]?.body).toEqual(new Uint8Array([1]));
		const original: AtomicQueueRequest = {
			kind: "enqueue",
			input: {
				operation: op(1),
				message: {
					idempotencyKey: "job",
					body: new Uint8Array([1]),
					attributes: [],
				},
			},
		};
		expect(
			transitionAtomicQueue(restored.state, original, 1001, limits).outcome,
		).toMatchObject({ status: "committed" });
	});
	it("rejects altered messages, counters, receipts and limit profiles", () => {
		const { state } = fixture();
		const encoded = encodeAtomicQueueCheckpoint(state, 1007, limits);
		const source = new TextDecoder().decode(encoded);
		const mutate = (change: (value: any[]) => void) => {
			const value = JSON.parse(source);
			change(value);
			return new TextEncoder().encode(JSON.stringify(value));
		};
		expect(() =>
			decodeAtomicQueueCheckpoint(
				mutate((value) => {
					value[3] = 1;
				}),
				limits,
			),
		).toThrow();
		expect(() =>
			decodeAtomicQueueCheckpoint(
				mutate((value) => {
					value[5][0][3] = "CQI=";
				}),
				limits,
			),
		).toThrow();
		expect(() =>
			decodeAtomicQueueCheckpoint(
				mutate((value) => {
					value[6][0][1][1] = "m999";
				}),
				limits,
			),
		).toThrow();
		expect(() =>
			decodeAtomicQueueCheckpoint(
				mutate((value) => {
					value[6].push(value[6][0]);
				}),
				limits,
			),
		).toThrow();
		expect(() =>
			decodeAtomicQueueCheckpoint(
				mutate((value) => {
					value[6][0][0][5] = "CQI=";
				}),
				limits,
			),
		).toThrow();
		expect(() =>
			decodeAtomicQueueCheckpoint(
				mutate((value) => {
					const receipt = value[6].find(
						(entry: unknown[]) =>
							Array.isArray(entry[0]) && entry[0][0] === "d",
					);
					receipt[1][1][0][3] = "CQI=";
				}),
				limits,
			),
		).toThrow();
		expect(() =>
			decodeAtomicQueueCheckpoint(encoded, { ...limits, batchSize: 1 }),
		).toThrow();
	});
});
