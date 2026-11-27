import { describe, expect, it } from "vitest";
import {
	DURABLE_QUEUE_MAX_LIMITS,
	type DurableQueue,
	durableQueueOperation,
} from "../../../core/src/ports/durable-queue.js";
import { scopeAwsQueue } from "../src/aws-scoped-queue.js";

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
const operation = durableQueueOperation(10000, "abcdefghijklmnop");
const request = () => ({
	operation,
	message: { idempotencyKey: "job", body: new Uint8Array([1]), attributes: [] },
});
function provider(enqueue: DurableQueue["enqueue"]): DurableQueue {
	return {
		limits: async () => ({ status: "available", value: limits }),
		enqueue,
		dequeue: async () => ({ status: "committed", value: [] }),
		complete: async (value) => ({
			status: "committed",
			value: { messageId: value.messageId, leaseId: value.leaseId },
		}),
		release: async (value) => ({
			status: "committed",
			value: { messageId: value.messageId, leaseId: value.leaseId },
		}),
		extendLease: async () => ({ status: "rejected", code: "lease-lost" }),
	};
}

describe("AWS application queue scope", () => {
	it("snapshots the full request before authorization can mutate caller data", async () => {
		const input = request();
		let seen: Parameters<DurableQueue["enqueue"]>[0] | undefined;
		const port = provider(async (value) => {
			seen = value;
			return {
				status: "committed",
				value: {
					messageId: "m1",
					idempotencyKey: value.message.idempotencyKey,
				},
			};
		});
		const scoped = scopeAwsQueue(port, limits, ["enqueue"], () => {
			input.message.body[0] = 9;
			input.message.idempotencyKey = "changed";
			return true;
		});
		expect(await scoped.enqueue(input)).toEqual({
			status: "committed",
			value: { messageId: "m1", idempotencyKey: "job" },
		});
		expect(seen?.message.body).toEqual(new Uint8Array([1]));
	});
	it("withholds disallowed operations and expired request scopes as unknown", async () => {
		let calls = 0;
		let active = true;
		const port = provider(async (value) => {
			calls++;
			return {
				status: "committed",
				value: {
					messageId: "m1",
					idempotencyKey: value.message.idempotencyKey,
				},
			};
		});
		const scoped = scopeAwsQueue(port, limits, ["dequeue"], () => active);
		expect(await scoped.enqueue(request())).toMatchObject({
			status: "unknown",
			operation,
		});
		expect(calls).toBe(0);
		active = false;
		expect(
			await scoped.dequeue({
				operation,
				maxMessages: 1,
				visibilityTimeoutMs: 1,
			}),
		).toMatchObject({ status: "unknown", operation });
		expect(await scoped.limits()).toEqual({ status: "unavailable" });
	});
	it("returns unknown if authorization changes after the provider commits", async () => {
		let active = true;
		const port = provider(async (value) => {
			active = false;
			return {
				status: "committed",
				value: {
					messageId: "m1",
					idempotencyKey: value.message.idempotencyKey,
				},
			};
		});
		const scoped = scopeAwsQueue(port, limits, ["enqueue"], () => active);
		expect(await scoped.enqueue(request())).toMatchObject({
			status: "unknown",
			operation,
		});
	});
	it("rejects proxy inputs without invoking traps", async () => {
		let traps = 0;
		const input = new Proxy(request(), {
			ownKeys() {
				traps++;
				throw Error("trap");
			},
		});
		const scoped = scopeAwsQueue(
			provider(async () => ({ status: "rejected", code: "unavailable" })),
			limits,
			["enqueue"],
			() => true,
		);
		await expect(scoped.enqueue(input)).rejects.toThrow();
		expect(traps).toBe(0);
	});
});
