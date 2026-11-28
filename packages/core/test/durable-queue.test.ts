import { describe, expect, it } from "vitest";
import {
	DURABLE_QUEUE_CONTRACT,
	DURABLE_QUEUE_MAX_LIMITS,
	DURABLE_QUEUE_WIT_INTERFACE,
	durableQueueOperation,
	parseDurableQueueLimits,
	parseDurableQueueOperation,
} from "../src/ports/durable-queue.js";

describe("durable queue operation identity", () => {
	it("binds the nonce and absolute expiry to an immutable request identity", () => {
		const operation = durableQueueOperation(
			1_700_000_000_123,
			"queue_nonce_12345",
		);
		expect(operation).toEqual({
			id: "v1.1700000000123.queue_nonce_12345",
			expiresAtMs: 1_700_000_000_123,
		});
		expect(Object.isFrozen(operation)).toBe(true);
		const input = { ...operation };
		const captured = parseDurableQueueOperation(input);
		input.expiresAtMs++;
		expect(captured).toEqual(operation);
		expect(() => parseDurableQueueOperation(input)).toThrow(
			"invalid durable queue operation",
		);
	});

	it("retains validation when application code replaces built-in methods", () => {
		const originalExec = RegExp.prototype.exec;
		const originalDefine = Object.defineProperty;
		let operation: ReturnType<typeof durableQueueOperation> | undefined;
		let limits: ReturnType<typeof parseDurableQueueLimits> | undefined;
		try {
			Reflect.set(RegExp.prototype, "exec", () => null);
			Reflect.set(Object, "defineProperty", () => {
				throw new Error("replaced");
			});
			operation = durableQueueOperation(1, "queue_nonce_12345");
			limits = parseDurableQueueLimits({ ...DURABLE_QUEUE_MAX_LIMITS });
		} finally {
			Reflect.set(RegExp.prototype, "exec", originalExec);
			Reflect.set(Object, "defineProperty", originalDefine);
		}
		expect(operation?.id).toBe("v1.1.queue_nonce_12345");
		expect(limits?.batchSize).toBe(DURABLE_QUEUE_MAX_LIMITS.batchSize);
	});

	it("rejects proxy identities without invoking their traps", () => {
		let traps = 0;
		const input = new Proxy(
			{ id: "v1.1.queue_nonce_12345", expiresAtMs: 1 },
			{
				ownKeys() {
					traps++;
					return ["id", "expiresAtMs"];
				},
			},
		);
		expect(() => parseDurableQueueOperation(input)).toThrow();
		expect(traps).toBe(0);
	});

	it.each([
		{ id: "v1.01.queue_nonce_12345", expiresAtMs: 1 },
		{ id: "v1.1.queue_nonce_12345", expiresAtMs: 2 },
		{ id: "v1.1.short", expiresAtMs: 1 },
		{ id: `v1.1.${"a".repeat(65)}`, expiresAtMs: 1 },
		{ id: "v1.1.queue_nonce_12345", expiresAtMs: Number.MAX_SAFE_INTEGER + 1 },
	])("rejects malformed or unbounded operation identities", (value) => {
		expect(() => parseDurableQueueOperation(value)).toThrow(
			"invalid durable queue operation",
		);
	});
});

describe("provider-neutral queue limits", () => {
	it("copies bounded limits and advertises no provider by itself", () => {
		const input = { ...DURABLE_QUEUE_MAX_LIMITS };
		const limits = parseDurableQueueLimits(input);
		input.batchSize = 1;
		expect(limits).toEqual(DURABLE_QUEUE_MAX_LIMITS);
		expect(Object.isFrozen(limits)).toBe(true);
		expect(DURABLE_QUEUE_CONTRACT).toBe("hobo.durable-queue/v1");
		expect(DURABLE_QUEUE_WIT_INTERFACE).toBe("hobo:queue/queue@0.1.0");
	});

	it("accepts providers without delay or message attributes explicitly", () => {
		const limits = parseDurableQueueLimits({
			...DURABLE_QUEUE_MAX_LIMITS,
			delayMs: 0,
			attributeCount: 0,
			attributeBytes: 0,
		});
		expect(limits).toMatchObject({
			delayMs: 0,
			attributeCount: 0,
			attributeBytes: 0,
		});
	});

	it.each(
		Object.entries(DURABLE_QUEUE_MAX_LIMITS),
	)("rejects an unbounded or nonintegral %s limit", (name, maximum) => {
		for (const value of [
			-1,
			0.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			maximum + 1,
		]) {
			expect(() =>
				parseDurableQueueLimits({ ...DURABLE_QUEUE_MAX_LIMITS, [name]: value }),
			).toThrow("invalid durable queue limits");
		}
	});

	it("rejects incomplete, inconsistent, and extra fields", () => {
		const { leaseMs: _leaseMs, ...missing } = DURABLE_QUEUE_MAX_LIMITS;
		for (const value of [
			missing,
			{ ...DURABLE_QUEUE_MAX_LIMITS, extra: 1 },
			{ ...DURABLE_QUEUE_MAX_LIMITS, attributeCount: 0 },
			{ ...DURABLE_QUEUE_MAX_LIMITS, attributeBytes: 0 },
			{ ...DURABLE_QUEUE_MAX_LIMITS, batchSize: 0 },
		]) {
			expect(() => parseDurableQueueLimits(value)).toThrow();
		}
	});

	it("does not invoke inherited descriptor accessors", () => {
		let calls = 0;
		let limits: ReturnType<typeof parseDurableQueueLimits> | undefined;
		try {
			Object.defineProperty(Object.prototype, "get", {
				configurable: true,
				get() {
					calls++;
					throw new Error("inherited accessor");
				},
			});
			limits = parseDurableQueueLimits({ ...DURABLE_QUEUE_MAX_LIMITS });
		} finally {
			Reflect.deleteProperty(Object.prototype, "get");
		}
		expect(calls).toBe(0);
		expect(limits?.batchSize).toBe(DURABLE_QUEUE_MAX_LIMITS.batchSize);
	});

	it("refuses accessors and proxies without executing caller code", () => {
		let calls = 0;
		const getter = {
			...DURABLE_QUEUE_MAX_LIMITS,
			get batchSize() {
				calls++;
				return 1;
			},
		};
		const proxy = new Proxy(
			{ ...DURABLE_QUEUE_MAX_LIMITS },
			{
				ownKeys(target) {
					calls++;
					return Reflect.ownKeys(target);
				},
			},
		);
		expect(() => parseDurableQueueLimits(getter)).toThrow();
		expect(() => parseDurableQueueLimits(proxy)).toThrow();
		expect(calls).toBe(0);
	});
});
