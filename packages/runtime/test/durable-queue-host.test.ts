import { describe, expect, it } from "vitest";
import { DURABLE_QUEUE_MAX_LIMITS, type DurableQueue } from "@hobo/core";
import { createDurableQueueWitHost } from "../src/durable-queue-host.js";

const limits = {
	...DURABLE_QUEUE_MAX_LIMITS,
	nameBytes: 32,
	payloadBytes: 16,
	attributeCount: 2,
	attributeBytes: 16,
	batchSize: 2,
	leaseMs: 100,
	operationWindowMs: 5000,
};
const operation = { id: "v1.2000.abcdefghijklmnop", expiresAtMs: 2000n };
const request = () => ({
	operation,
	message: { idempotencyKey: "job", body: new Uint8Array([1]), attributes: [] },
});
const provider = (enqueue: DurableQueue["enqueue"]): DurableQueue => ({
	limits: async () => ({ status: "available", value: limits }),
	enqueue,
	dequeue: async () => ({ status: "committed", value: [] }),
	complete: async (input) => ({
		status: "committed",
		value: { messageId: input.messageId, leaseId: input.leaseId },
	}),
	release: async (input) => ({
		status: "committed",
		value: { messageId: input.messageId, leaseId: input.leaseId },
	}),
	extendLease: async () => ({ status: "rejected", code: "lease-lost" }),
});
const options = {
	limits,
	maxInFlight: 1,
	timeoutMs: 100,
	now: () => 1000,
	authorize: () => true,
};
const committed: DurableQueue["enqueue"] = async (input) => ({
	status: "committed",
	value: { messageId: "message", idempotencyKey: input.message.idempotencyKey },
});

describe("durable queue async component host", () => {
	it("dispatches and discloses only validated authorized outcomes", async () => {
		const phases: string[] = [];
		const host = createDurableQueueWitHost(provider(committed), {
			...options,
			authorize: ({ phase }) => {
				phases.push(phase);
				return true;
			},
		});
		expect(await host.enqueue(request())).toEqual({
			tag: "committed",
			val: { messageId: "message", idempotencyKey: "job" },
		});
		expect(phases).toEqual(["dispatch", "disclose"]);
		expect(await host.limits()).toMatchObject({
			tag: "available",
			val: { leaseMs: 100n },
		});
	});
	it("does not dispatch invalid, expired, unauthorized or excessive-delay input", async () => {
		let calls = 0;
		const port = provider(async (input) => {
			calls++;
			return committed(input);
		});
		const denied = createDurableQueueWitHost(port, {
			...options,
			authorize: () => false,
		});
		expect(await denied.enqueue(request())).toMatchObject({ tag: "unknown" });
		const expired = createDurableQueueWitHost(port, {
			...options,
			now: () => 2000,
		});
		expect(await expired.enqueue(request())).toMatchObject({ tag: "expired" });
		const host = createDurableQueueWitHost(port, {
			...options,
			limits: { ...limits, delayMs: 0 },
		});
		await expect(
			host.enqueue({
				...request(),
				message: { ...request().message, availableAtMs: 1001n },
			}),
		).resolves.toMatchObject({ tag: "unknown" });
		await expect(
			host.enqueue({
				...request(),
				message: { ...request().message, body: new Uint8Array(17) },
			}),
		).rejects.toThrow();
		expect(calls).toBe(0);
	});
	it("returns unknown for failed disclosure or a contradictory provider receipt", async () => {
		const revoked = createDurableQueueWitHost(provider(committed), {
			...options,
			authorize: ({ phase }) => phase === "dispatch",
		});
		expect(await revoked.enqueue(request())).toMatchObject({ tag: "unknown" });
		const malformed = createDurableQueueWitHost(
			provider(async () => ({
				status: "committed",
				value: { messageId: "message", idempotencyKey: "different" },
			})),
			options,
		);
		expect(await malformed.enqueue(request())).toMatchObject({
			tag: "unknown",
		});
	});
	it("holds capacity for a timed-out provider until its work settles", async () => {
		let finish: (() => void) | undefined;
		let calls = 0;
		const host = createDurableQueueWitHost(
			provider(async (input) => {
				calls++;
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				return committed(input);
			}),
			options,
		);
		expect(await host.enqueue(request())).toMatchObject({ tag: "unknown" });
		expect(await host.enqueue(request())).toMatchObject({ tag: "unknown" });
		expect(calls).toBe(1);
		if (finish === undefined) throw Error("provider did not start");
		finish();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const attempt = host.enqueue(request());
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls).toBe(2);
		if (finish === undefined) throw Error("provider did not restart");
		finish();
		expect(await attempt).toMatchObject({ tag: "committed" });
	});
	it("translates bounded deliveries and settlement receipts", async () => {
		const port = {
			...provider(committed),
			dequeue: async () => ({
				status: "committed" as const,
				value: [
					{
						messageId: "message",
						leaseId: "lease",
						idempotencyKey: "job",
						body: new Uint8Array([7]),
						attributes: [],
						leaseExpiresAtMs: 1200,
						deliveryAttempt: 1,
					},
				],
			}),
		};
		const host = createDurableQueueWitHost(port, options);
		expect(
			await host.dequeue({
				operation,
				maxMessages: 1,
				visibilityTimeoutMs: 10n,
			}),
		).toMatchObject({
			tag: "committed",
			val: [
				{
					messageId: "message",
					leaseExpiresAtMs: 1200n,
					body: new Uint8Array([7]),
				},
			],
		});
		expect(
			await host.complete({
				operation,
				messageId: "message",
				leaseId: "lease",
			}),
		).toEqual({
			tag: "committed",
			val: { messageId: "message", leaseId: "lease" },
		});
		expect(
			await host.release({ operation, messageId: "message", leaseId: "lease" }),
		).toEqual({
			tag: "committed",
			val: { messageId: "message", leaseId: "lease" },
		});
		expect(
			await host.extendLease({
				operation,
				messageId: "message",
				leaseId: "lease",
				visibilityTimeoutMs: 10n,
			}),
		).toEqual({ tag: "rejected", val: "lease-lost" });
	});
	it("rechecks expiry after asynchronous authorization", async () => {
		let clock = 1000;
		let calls = 0;
		const host = createDurableQueueWitHost(
			provider(async (input) => {
				calls++;
				return committed(input);
			}),
			{
				...options,
				now: () => clock,
				authorize: async () => {
					clock = 2000;
					return true;
				},
			},
		);
		expect(await host.enqueue(request())).toMatchObject({ tag: "expired" });
		expect(calls).toBe(0);
	});

	it("does not let a replaced Promise.race fabricate a committed result", async () => {
		let finish: (() => void) | undefined;
		const host = createDurableQueueWitHost(
			provider(async (input) => {
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				return committed(input);
			}),
			options,
		);
		const original = Promise.race;
		let attempt: ReturnType<typeof host.enqueue>;
		try {
			// SAFETY: the original intrinsic is restored before awaiting the result.
			Promise.race = () =>
				Promise.resolve({
					tag: "committed",
					val: { messageId: "fake", idempotencyKey: "job" },
				}) as never;
			attempt = host.enqueue(request());
		} finally {
			Promise.race = original;
		}
		expect(await attempt).toMatchObject({ tag: "unknown" });
		if (finish === undefined) throw Error("provider did not start");
		finish();
	});
	it("does not dispatch the same in-flight operation when Set.has changes", async () => {
		let finish: (() => void) | undefined;
		let calls = 0;
		const host = createDurableQueueWitHost(
			provider(async (input) => {
				calls++;
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				return committed(input);
			}),
			{ ...options, maxInFlight: 2 },
		);
		const first = host.enqueue(request());
		await new Promise((resolve) => setTimeout(resolve, 0));
		const original = Set.prototype.has;
		let second: ReturnType<typeof host.enqueue>;
		try {
			Set.prototype.has = () => false;
			second = host.enqueue(request());
		} finally {
			Set.prototype.has = original;
		}
		expect(await second).toMatchObject({ tag: "unknown" });
		expect(calls).toBe(1);
		if (finish === undefined) throw Error("provider did not start");
		finish();
		expect(await first).toMatchObject({ tag: "committed" });
	});

	it("uses captured promise observation and returns non-thenable variants", async () => {
		const host = createDurableQueueWitHost(provider(committed), options);
		/* oxlint-disable unicorn/no-thenable -- SAFETY: the original intrinsic is restored before awaiting. */
		const original = Object.getOwnPropertyDescriptor(Promise.prototype, "then");
		let attempt: ReturnType<typeof host.enqueue>;
		try {
			Object.defineProperty(Promise.prototype, "then", {
				configurable: true,
				value() {
					throw Error("changed then");
				},
			});
			attempt = host.enqueue(request());
		} finally {
			if (original !== undefined)
				Object.defineProperty(Promise.prototype, "then", original);
		}
		/* oxlint-enable unicorn/no-thenable */
		const result = await attempt;
		expect(result).toMatchObject({ tag: "committed" });
		expect(Object.getPrototypeOf(result)).toBeNull();
	});

	it("does not start a provider after promise observation fails", async () => {
		let calls = 0;
		const host = createDurableQueueWitHost(
			provider(async (input) => {
				calls++;
				return committed(input);
			}),
			options,
		);
		const original = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
		let attempt: ReturnType<typeof host.enqueue>;
		try {
			Object.defineProperty(Promise, Symbol.species, {
				configurable: true,
				get() {
					throw Error("species");
				},
			});
			attempt = host.enqueue(request());
		} finally {
			if (original !== undefined)
				Object.defineProperty(Promise, Symbol.species, original);
		}
		expect(await attempt).toMatchObject({ tag: "unknown" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls).toBe(0);
	});

	it("never starts provider work after authorization times out", async () => {
		let release: (() => void) | undefined;
		let calls = 0;
		const host = createDurableQueueWitHost(
			provider(async (input) => {
				calls++;
				return committed(input);
			}),
			{
				...options,
				authorize: async () => {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return true;
				},
			},
		);
		expect(await host.enqueue(request())).toMatchObject({ tag: "unknown" });
		if (release === undefined) throw Error("authorization did not start");
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls).toBe(0);
	});
});
