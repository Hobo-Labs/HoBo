import {
	parseConsumerGroupId,
	parseIdempotencyKey,
	parseQueueName,
	parseTopicName,
} from "@hobo/core";
import { describe, expect, it, vi } from "vitest";
import {
	createQueueEmulator,
	createTestHarness,
	createTopicEmulator,
	deployInProcess,
	destroyInProcess,
} from "../src/index.js";
import { fakeBindle } from "./fixtures.js";

const queueName = parseQueueName("orders");
const key = parseIdempotencyKey("order-1");
const topicName = parseTopicName("orders");

function app() {
	return fakeBindle({
		resources: {
			orders: { kind: "queue" },
			other: { kind: "queue" },
			events: { kind: "topic" },
			db: { kind: "data" },
			auth: { kind: "auth" },
		},
		handlers: {},
	});
}

describe("in-process service emulators", () => {
	it("delivers, deduplicates and redelivers queue messages on controlled time", async () => {
		const harness = createTestHarness();
		const bindle = app();
		const graph = await harness.deploy(bindle)();
		try {
			const queue = graph.queue("orders");
			const first = await queue.enqueue(
				queueName,
				{ id: 1 },
				{ idempotencyKey: key },
			);
			const retry = await queue.enqueue(
				queueName,
				{ id: 1 },
				{ idempotencyKey: key },
			);
			expect(retry).toMatchObject({
				messageId: first.messageId,
				deduped: true,
			});
			const [lease] = queue.dequeue(queueName, { visibilityTimeoutMs: 10 });
			expect(lease?.body).toEqual({ id: 1 });
			expect(queue.dequeue(queueName)).toEqual([]);
			graph.queueClock("orders")?.advance(10);
			const [redelivered] = queue.dequeue(queueName);
			expect(redelivered).toMatchObject({
				messageId: first.messageId,
				deliveryAttempt: 2,
			});
			if (!redelivered) throw new Error("message was not redelivered");
			queue.complete(redelivered.messageId, redelivered.leaseId);
			expect(queue.dequeue(queueName)).toEqual([]);
			expect(graph.queue("other").dequeue(queueName)).toEqual([]);
			expect(graph.resource("orders").fidelity).toBe("simulated");
			expect(graph.resource("auth").fidelity).toBe("mocked");
			expect(graph.fidelity().prodReadinessClaimable).toBe(false);
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("publishes through the Messaging port with independent consumer groups", async () => {
		const harness = createTestHarness();
		const bindle = app();
		const graph = await harness.deploy(bindle)();
		try {
			const topic = graph.topic("events");
			await topic.publish(topicName, { id: 7 });
			const [a] = await topic.consume(topicName, parseConsumerGroupId("a"));
			const [b] = await topic.consume(topicName, parseConsumerGroupId("b"));
			expect(a?.body).toEqual({ id: 7 });
			expect(b?.body).toEqual({ id: 7 });
			if (!a) throw new Error("message was not delivered");
			await topic.ack(a.messageId, a.leaseId);
			expect(await topic.consume(topicName, parseConsumerGroupId("a"))).toEqual(
				[],
			);
			expect(graph.resource("events").fidelity).toBe("simulated");
			expect(graph.fidelity().assertedAgainst).toContainEqual({
				alias: "events",
				fidelity: "simulated",
			});
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("starts with isolated state for each graph and after redeploy", async () => {
		const harness = createTestHarness();
		const first = app();
		const second = app();
		const one = await harness.deploy(first)();
		const two = await harness.deploy(second)();
		try {
			await one
				.queue("orders")
				.enqueue(queueName, "first", { idempotencyKey: key });
			await one.topic("events").publish(topicName, "first");
			expect(two.queue("orders").dequeue(queueName)).toEqual([]);
			expect(
				await two.topic("events").consume(topicName, parseConsumerGroupId("g")),
			).toEqual([]);
			await harness.destroy(first)();
			const replacement = await harness.deploy(first)();
			expect(replacement.queue("orders").dequeue(queueName)).toEqual([]);
		} finally {
			await harness.destroy(first)();
			await harness.destroy(second)();
		}
	});

	it("uses supplied port implementations and records their declared fidelity", async () => {
		const calls: string[] = [];
		const harness = createTestHarness({
			stage: "pr-42",
			emulators: {
				queue: ({ alias, stage }) => {
					calls.push(`${stage}:${alias}`);
					return {
						...createQueueEmulator(),
						fidelity: "mocked",
						close: () => {
							calls.push(`closed:${alias}`);
						},
					};
				},
				topic: () => createTopicEmulator({ tenantId: "example" }),
			},
		});
		const bindle = app();
		const graph = await harness.deploy(bindle)();
		expect(graph.resource("orders").fidelity).toBe("mocked");
		expect(graph.queue("orders")).toBeDefined();
		expect(graph.fidelity().prodReadinessClaimable).toBe(false);
		await harness.destroy(bindle)();
		expect(calls).toEqual([
			"pr-42:orders",
			"pr-42:other",
			"closed:other",
			"closed:orders",
		]);
	});

	it("refuses the wrong kind and unknown aliases", async () => {
		const harness = createTestHarness();
		const bindle = app();
		const graph = await harness.deploy(bindle)();
		try {
			expect(() => graph.queue("events")).toThrowError(
				expect.objectContaining({ code: "HARNESS_EMULATOR_UNAVAILABLE" }),
			);
			expect(() => graph.topic("missing")).toThrowError(
				expect.objectContaining({ code: "HARNESS_ALIAS_UNKNOWN" }),
			);
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("refuses an invalid factory instead of silently using a default", async () => {
		// SAFETY: model an invalid JavaScript caller bypassing the TypeScript contract.
		await expect(
			deployInProcess(app(), "test", { queue: null } as never),
		).rejects.toMatchObject({
			code: "HARNESS_EMULATOR_INVALID",
		});
	});

	it("unwinds started emulators when a later factory returns an invalid implementation", async () => {
		const closed: string[] = [];
		const bindle = fakeBindle({
			resources: {
				first: { kind: "queue" },
				second: { kind: "topic", dependsOn: ["first"] },
			},
			handlers: {},
		});
		await expect(
			deployInProcess(bindle, "test", {
				queue: () => ({
					...createQueueEmulator(),
					close: () => {
						closed.push("queue");
					},
				}),
				// SAFETY: deliberately violate the TypeScript factory contract to test the JavaScript parse boundary.
				topic: () =>
					({
						port: {},
						fidelity: "real",
						close: () => {
							closed.push("topic");
						},
					}) as never,
			}),
		).rejects.toMatchObject({ code: "HARNESS_EMULATOR_INVALID" });
		expect(closed).toEqual(["topic", "queue"]);
	});

	it("closes each service once even when teardown is called concurrently", async () => {
		let closed = 0;
		const deployment = await deployInProcess(
			fakeBindle({ resources: { q: { kind: "queue" } }, handlers: {} }),
			"test",
			{
				queue: () => ({
					...createQueueEmulator(),
					close: async () => {
						closed += 1;
					},
				}),
			},
		);
		await Promise.all([
			destroyInProcess(deployment),
			destroyInProcess(deployment),
		]);
		await destroyInProcess(deployment);
		expect(closed).toBe(1);
	});

	it("waits for an in-flight harness teardown in every concurrent caller", async () => {
		let release: (() => void) | undefined;
		let started: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const closing = new Promise<void>((resolve) => {
			started = resolve;
		});
		let closes = 0;
		const harness = createTestHarness({
			emulators: {
				queue: () => ({
					...createQueueEmulator(),
					async close() {
						closes += 1;
						started?.();
						await blocked;
					},
				}),
			},
		});
		const bindle = fakeBindle({
			resources: { q: { kind: "queue" } },
			handlers: {},
		});
		await harness.deploy(bindle)();
		const first = harness.destroy(bindle)();
		await closing;
		let secondFinished = false;
		const second = harness
			.destroy(bindle)()
			.then(() => {
				secondFinished = true;
			});
		await Promise.resolve();
		await Promise.resolve();
		try {
			expect(secondFinished).toBe(false);
		} finally {
			release?.();
			await Promise.all([first, second]);
		}
		expect(closes).toBe(1);
	});

	it("does not discard a replacement graph when an older deployment fails", async () => {
		let calls = 0;
		let failFirst: (() => void) | undefined;
		const harness = createTestHarness({
			emulators: {
				queue: () => {
					calls += 1;
					if (calls === 1)
						return new Promise((_resolve, reject) => {
							failFirst = () => reject(new Error("first failed"));
						});
					return createQueueEmulator();
				},
			},
		});
		const bindle = fakeBindle({
			resources: { jobs: { kind: "queue" } },
			handlers: {},
		});
		const oldDeploy = harness
			.deploy(bindle)()
			.catch((error: Error) => error);
		const oldDestroy = harness
			.destroy(bindle)()
			.catch((error: Error) => error);
		const pending = harness.deploy(bindle)();
		await vi.waitFor(() => {
			if (!failFirst) throw new Error("first factory did not start");
		});
		failFirst?.();
		await oldDeploy;
		await oldDestroy;
		const replacement = await pending;
		try {
			expect(await harness.deploy(bindle)()).toBe(replacement);
			expect(calls).toBe(2);
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("keeps the replacement as the latest graph when an older deployment closes later", async () => {
		let calls = 0;
		let finishFirst: (() => void) | undefined;
		const harness = createTestHarness({
			emulators: {
				queue: () => {
					calls += 1;
					if (calls === 1)
						return new Promise((resolve) => {
							finishFirst = () => resolve(createQueueEmulator());
						});
					return createQueueEmulator();
				},
			},
		});
		const bindle = fakeBindle({
			resources: { jobs: { kind: "queue" } },
			handlers: {},
		});
		const oldDeploy = harness.deploy(bindle)();
		const oldDestroy = harness.destroy(bindle)();
		const pending = harness.deploy(bindle)();
		await vi.waitFor(() => {
			if (!finishFirst) throw new Error("first factory did not start");
		});
		finishFirst?.();
		await oldDeploy;
		await oldDestroy;
		await pending;
		try {
			await expect(harness.untilReady("jobs")).rejects.toMatchObject({
				code: "HARNESS_ENDPOINT_UNAVAILABLE",
			});
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("continues reverse-order cleanup after a close fails", async () => {
		const closed: string[] = [];
		const deployment = await deployInProcess(
			fakeBindle({
				resources: {
					first: { kind: "queue" },
					second: { kind: "queue", dependsOn: ["first"] },
				},
				handlers: {},
			}),
			"test",
			{
				queue: ({ alias }) => ({
					...createQueueEmulator(),
					close: () => {
						closed.push(alias);
						if (alias === "second") throw new Error("close failed");
					},
				}),
			},
		);
		await expect(destroyInProcess(deployment)).rejects.toThrow(
			"emulator teardown failed",
		);
		expect(closed).toEqual(["second", "first"]);
	});
});
