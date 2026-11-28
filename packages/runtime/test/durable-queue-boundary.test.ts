import { describe, expect, it } from "vitest";
import { DURABLE_QUEUE_MAX_LIMITS } from "@hobo/core";
import {
	parseQueueDequeue,
	parseQueueEnqueue,
	parseQueueSettlement,
	parseQueueProviderOutcome,
} from "../src/durable-queue-boundary.js";

const limits = {
	...DURABLE_QUEUE_MAX_LIMITS,
	nameBytes: 16,
	payloadBytes: 4,
	attributeCount: 2,
	attributeBytes: 8,
	batchSize: 2,
	leaseMs: 100,
};
const op = { id: "v1.1234.abcdefghijklmnop", expiresAtMs: 1234n };
const request = () => ({
	operation: op,
	message: {
		idempotencyKey: "job",
		body: new Uint8Array([1, 2]),
		attributes: [{ key: "k", value: "v" }],
	},
});

describe("durable queue component boundary", () => {
	it("copies accepted request data before the caller can mutate it", () => {
		const input = request();
		const result = parseQueueEnqueue(input, limits);
		input.message.body[0] = 9;
		input.message.attributes[0]!.value = "changed";
		expect([...result.message.body]).toEqual([1, 2]);
		expect(result.message.attributes).toEqual([{ key: "k", value: "v" }]);
		expect(result.operation).toEqual({ id: op.id, expiresAtMs: 1234 });
	});
	it("rejects caller accessors and proxies without executing them", () => {
		let called = 0;
		const accessor = {
			...request(),
			get message() {
				called++;
				throw Error("getter");
			},
		};
		const proxy = new Proxy(request(), {
			ownKeys() {
				called++;
				throw Error("trap");
			},
		});
		expect(() => parseQueueEnqueue(accessor, limits)).toThrow();
		expect(() => parseQueueEnqueue(proxy, limits)).toThrow();
		expect(called).toBe(0);
	});
	it("bounds bytes, combined attributes and Unicode", () => {
		const a = request();
		a.message.body = new Uint8Array(5);
		const b = request();
		b.message.attributes = [{ key: "abcde", value: "wxyz" }];
		const c = request();
		c.message.idempotencyKey = "bad\ud800";
		const d = request();
		d.message.attributes = [{ key: "a\n", value: "b" }];
		for (const input of [a, b, c, d])
			expect(() => parseQueueEnqueue(input, limits)).toThrow();
	});
	it("rejects shared bytes and sparse or accessor-backed attribute arrays", () => {
		const a = request();
		a.message.body = new Uint8Array(new SharedArrayBuffer(2));
		const b = request();
		b.message.attributes = Array(1);
		const c = request();
		Object.defineProperty(c.message.attributes, "0", {
			get() {
				throw Error("getter");
			},
			enumerable: true,
		});
		for (const input of [a, b, c])
			expect(() => parseQueueEnqueue(input, limits)).toThrow();
	});
	it("checks operation expiry encoding and bounded batch and lease values", () => {
		expect(
			parseQueueDequeue(
				{ operation: op, maxMessages: 2, visibilityTimeoutMs: 100n },
				limits,
			),
		).toEqual({
			operation: { id: op.id, expiresAtMs: 1234 },
			maxMessages: 2,
			visibilityTimeoutMs: 100,
		});
		for (const input of [
			{
				operation: { ...op, expiresAtMs: 1235n },
				maxMessages: 1,
				visibilityTimeoutMs: 1n,
			},
			{ operation: op, maxMessages: 0, visibilityTimeoutMs: 1n },
			{ operation: op, maxMessages: 3, visibilityTimeoutMs: 1n },
			{ operation: op, maxMessages: 1, visibilityTimeoutMs: 101n },
		])
			expect(() => parseQueueDequeue(input, limits)).toThrow();
	});
	it("validates settlement fields and extension limits", () => {
		const input = { operation: op, messageId: "message", leaseId: "lease" };
		expect(parseQueueSettlement(input, limits, false).leaseId).toBe("lease");
		expect(
			parseQueueSettlement({ ...input, visibilityTimeoutMs: 1n }, limits, true)
				.visibilityTimeoutMs,
		).toBe(1);
		expect(() =>
			parseQueueSettlement({ ...input, visibilityTimeoutMs: 0n }, limits, true),
		).toThrow();
		expect(() =>
			parseQueueSettlement({ ...input, leaseId: "" }, limits, false),
		).toThrow();
		expect(() =>
			parseQueueSettlement({ ...input, unexpected: true }, limits, false),
		).toThrow();
	});
});

describe("durable queue provider outcome boundary", () => {
	const expected = { id: op.id, expiresAtMs: 1234 };
	const item = () => ({
		messageId: "msg",
		leaseId: "lease",
		idempotencyKey: "job",
		body: new Uint8Array([1, 2]),
		attributes: [{ key: "k", value: "v" }],
		leaseExpiresAtMs: 3000,
		deliveryAttempt: 1,
	});
	it("preserves matching uncertainty and rejects a different operation identity", () => {
		expect(
			parseQueueProviderOutcome(
				{ status: "unknown", operation: expected },
				expected,
				limits,
				{ kind: "enqueue", idempotencyKey: "job" },
			),
		).toEqual({ status: "unknown", operation: expected });
		expect(() =>
			parseQueueProviderOutcome(
				{
					status: "unknown",
					operation: { ...expected, id: "v1.1234.ponmlkjihgfedcba" },
				},
				expected,
				limits,
				{ kind: "enqueue", idempotencyKey: "job" },
			),
		).toThrow();
	});
	it("does not let changed array helpers forge a provider delivery", () => {
		const map = Object.getOwnPropertyDescriptor(Array.prototype, "map");
		const includes = Object.getOwnPropertyDescriptor(
			Array.prototype,
			"includes",
		);
		let parsed: ReturnType<typeof parseQueueProviderOutcome>;
		try {
			Object.defineProperty(Array.prototype, "map", {
				configurable: true,
				value: () => [],
			});
			Object.defineProperty(Array.prototype, "includes", {
				configurable: true,
				value: () => true,
			});
			parsed = parseQueueProviderOutcome(
				{ status: "committed", value: [item()] },
				expected,
				limits,
				{ kind: "dequeue", maxMessages: 1 },
			);
		} finally {
			if (map !== undefined) Object.defineProperty(Array.prototype, "map", map);
			if (includes !== undefined)
				Object.defineProperty(Array.prototype, "includes", includes);
		}
		if (parsed.status !== "committed" || !Array.isArray(parsed.value))
			throw Error("expected delivery");
		expect(parsed.value).toHaveLength(1);
		expect(parsed.value[0].messageId).toBe("msg");
	});

	it("requires known rejection codes and exactly shaped responses", () => {
		expect(
			parseQueueProviderOutcome(
				{ status: "rejected", code: "lease-lost" },
				expected,
				limits,
				{ kind: "settlement", messageId: "msg", leaseId: "lease" },
			),
		).toEqual({ status: "rejected", code: "lease-lost" });
		expect(() =>
			parseQueueProviderOutcome(
				{ status: "rejected", code: "invented" },
				expected,
				limits,
				{ kind: "enqueue" },
			),
		).toThrow();
		expect(() =>
			parseQueueProviderOutcome(
				{ status: "rejected", code: "lease-lost", value: "hidden" },
				expected,
				limits,
				{ kind: "enqueue" },
			),
		).toThrow();
	});
	it("matches receipts to the request and refuses duplicate deliveries", () => {
		expect(() =>
			parseQueueProviderOutcome(
				{
					status: "committed",
					value: { messageId: "msg", idempotencyKey: "other" },
				},
				expected,
				limits,
				{ kind: "enqueue", idempotencyKey: "job" },
			),
		).toThrow();
		expect(() =>
			parseQueueProviderOutcome(
				{ status: "committed", value: { messageId: "msg", leaseId: "other" } },
				expected,
				limits,
				{ kind: "settlement", messageId: "msg", leaseId: "lease" },
			),
		).toThrow();
		expect(() =>
			parseQueueProviderOutcome(
				{ status: "committed", value: [item(), item()] },
				expected,
				limits,
				{ kind: "dequeue", maxMessages: 2 },
			),
		).toThrow();
	});
	it("copies delivery bytes and verifies leased response bounds", () => {
		const response = item();
		const parsed = parseQueueProviderOutcome(
			{ status: "committed", value: [response] },
			expected,
			limits,
			{ kind: "dequeue", maxMessages: 1 },
		);
		response.body[0] = 7;
		if (parsed.status !== "committed" || !Array.isArray(parsed.value))
			throw Error("expected delivery");
		expect(parsed.value[0].body[0]).toBe(1);
		expect(() =>
			parseQueueProviderOutcome(
				{ status: "committed", value: [{ ...item(), deliveryAttempt: 0 }] },
				expected,
				limits,
				{ kind: "dequeue", maxMessages: 1 },
			),
		).toThrow();
		expect(() =>
			parseQueueProviderOutcome(
				{
					status: "committed",
					value: [{ ...item(), leaseExpiresAtMs: Number.MAX_SAFE_INTEGER + 1 }],
				},
				expected,
				limits,
				{ kind: "dequeue", maxMessages: 1 },
			),
		).toThrow();
	});
	it("refuses a mismatched extension and provider getters without invoking them", () => {
		expect(() =>
			parseQueueProviderOutcome(
				{ status: "committed", value: item() },
				expected,
				limits,
				{ kind: "extension", messageId: "msg", leaseId: "other" },
			),
		).toThrow();
		let called = 0;
		const bad = {
			status: "committed",
			get value() {
				called++;
				throw Error("getter");
			},
		};
		expect(() =>
			parseQueueProviderOutcome(bad, expected, limits, { kind: "extension" }),
		).toThrow();
		expect(called).toBe(0);
	});
});
