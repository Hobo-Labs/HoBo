import { runQueueClockConformance } from "@hobo/conformance";
import {
	parseActorKey,
	parseIdempotencyKey,
	parseQueueName,
	QUEUE_CLOCK_RUNTIME_PORT_CONTRACT_VERSION,
	QueueLeaseLostError,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import { createRuntimeLocalQueueClock } from "../src/replay.js";

describe("createRuntimeLocalQueueClock queue", () => {
	it("dedups duplicate enqueues by idempotency key before handling", async () => {
		const runtime = createRuntimeLocalQueueClock();
		const queue = parseQueueName("email");
		const key = parseIdempotencyKey("send-a");

		const first = await runtime.queue.enqueue(
			queue,
			{ to: "a@example.test" },
			{ idempotencyKey: key },
		);
		const retry = await runtime.queue.enqueue(
			queue,
			{ to: "a@example.test" },
			{ idempotencyKey: key },
		);
		const handled: string[] = [];

		await runtime.queue.handle(queue, async (message) => {
			handled.push(message.idempotencyKey);
		});

		expect(retry.deduped).toBe(true);
		expect(retry.messageId).toBe(first.messageId);
		expect(handled).toEqual([key]);
	});

	it("retries failed handlers at least once until completion", async () => {
		const runtime = createRuntimeLocalQueueClock();
		const queue = parseQueueName("jobs");
		const key = parseIdempotencyKey("job-retry");
		await runtime.queue.enqueue(
			queue,
			{ task: "retry" },
			{ idempotencyKey: key },
		);
		let attempts = 0;

		await expect(
			runtime.queue.handle(queue, async () => {
				attempts += 1;
				throw new Error("transient failure");
			}),
		).rejects.toThrow(/transient failure/);

		const retry = await runtime.queue.handle(queue, async () => {
			attempts += 1;
		});

		expect(attempts).toBe(2);
		expect(retry.handled).toEqual([expect.any(String)]);
	});

	it("suppresses duplicate effects when a completed message is redelivered", async () => {
		const runtime = createRuntimeLocalQueueClock();
		const queue = parseQueueName("payments");
		const key = parseIdempotencyKey("charge-1");
		const enqueued = await runtime.queue.enqueue(
			queue,
			{ cents: 500 },
			{ idempotencyKey: key },
		);
		const effects: string[] = [];

		await runtime.queue.handle(queue, async (message) => {
			effects.push(`charged:${message.idempotencyKey}`);
		});
		runtime.queue.simulateRedelivery(enqueued.messageId);
		const redelivery = await runtime.queue.handle(queue, async (message) => {
			effects.push(`charged:${message.idempotencyKey}`);
		});

		expect(effects).toEqual([`charged:${key}`]);
		expect(redelivery).toEqual({ handled: [], deduped: [enqueued.messageId] });
	});

	it("does not redeliver an expired lease while the handler is still active", async () => {
		const runtime = createRuntimeLocalQueueClock();
		const queue = parseQueueName("payments");
		const key = parseIdempotencyKey("charge-active");
		await runtime.queue.enqueue(queue, { cents: 500 }, { idempotencyKey: key });
		const effects: string[] = [];
		let finishHandler: (() => void) | undefined;

		const inFlight = runtime.queue.handle(
			queue,
			async (message) => {
				effects.push(`charged:${message.idempotencyKey}`);
				await new Promise<void>((resolve) => {
					finishHandler = resolve;
				});
			},
			{ visibilityTimeoutMs: 1 },
		);

		runtime.clock.advance(2);
		expect(runtime.queue.dequeue(queue, { visibilityTimeoutMs: 100 })).toEqual(
			[],
		);

		finishHandler?.();
		await inFlight;
		runtime.queue.simulateRedelivery("msg-1" as never);
		await runtime.queue.handle(queue, async (message) => {
			effects.push(`charged:${message.idempotencyKey}`);
		});

		expect(effects).toEqual([`charged:${key}`]);
	});

	it("signal enqueues actor messages with idempotent delivery", async () => {
		const runtime = createRuntimeLocalQueueClock();
		const actor = parseActorKey("actor:counter:1");
		const key = parseIdempotencyKey("signal-1");

		const first = await runtime.queue.signal(
			actor,
			{ type: "increment", by: 1 },
			{ idempotencyKey: key },
		);
		const retry = await runtime.queue.signal(
			actor,
			{ type: "increment", by: 1 },
			{ idempotencyKey: key },
		);
		const delivered: unknown[] = [];

		await runtime.queue.handle(first.queueName, async (message) => {
			delivered.push(message.body);
		});

		expect(retry.deduped).toBe(true);
		expect(delivered).toEqual([
			{ actorKey: actor, msg: { type: "increment", by: 1 } },
		]);
	});

	it("throws QueueLeaseLostError on unknown message complete", () => {
		const runtime = createRuntimeLocalQueueClock();
		expect(() =>
			runtime.queue.complete("msg-missing" as never, "lease-1" as never),
		).toThrow(QueueLeaseLostError);
	});
});

describe("queue conformance", () => {
	it("passes all six Queue + Clock conformance assertions", async () => {
		const { replayClockTrace } = await import("../src/replay.js");
		const report = await runQueueClockConformance(
			createRuntimeLocalQueueClock,
			{
				replayClockTrace,
			},
		);

		expect(report.contract).toBe(QUEUE_CLOCK_RUNTIME_PORT_CONTRACT_VERSION);
		for (const [name, status] of Object.entries(report.assertions)) {
			expect(status, name).toBe("pass");
		}
	});
});
