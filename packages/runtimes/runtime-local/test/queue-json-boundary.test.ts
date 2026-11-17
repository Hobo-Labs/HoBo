import { parseIdempotencyKey, parseQueueName } from "@hobo/core";
import { expect, it } from "vitest";
import { isJsonNumber, isJsonObject } from "../src/json.js";
import { createRuntimeLocalQueueClock } from "../src/replay.js";

it("rejects non-JSON bodies without consuming a message id", async () => {
	const runtime = createRuntimeLocalQueueClock();
	const queue = parseQueueName("jobs");
	const before = runtime.snapshot();
	for (const [index, body] of [
		{ n: Number.NaN },
		{ n: Number.POSITIVE_INFINITY },
		{ n: 1n },
	].entries()) {
		await expect(
			runtime.queue.enqueue(queue, body, {
				idempotencyKey: parseIdempotencyKey(`bad-${index}`),
			}),
		).rejects.toThrow("value cannot be represented as JSON");
	}
	await expect(
		runtime.queue.enqueue(
			queue,
			{ n: 1 },
			{ idempotencyKey: parseIdempotencyKey("bad-time"), availableAtMs: -1 },
		),
	).rejects.toThrow();
	expect(runtime.snapshot()).toEqual(before);
	const accepted = await runtime.queue.enqueue(
		queue,
		{ n: 1 },
		{ idempotencyKey: parseIdempotencyKey("good") },
	);
	expect(accepted.messageId).toBe("msg-1");
	const observed: number[] = [];
	await runtime.queue.handle(queue, async (message) => {
		if (!isJsonObject(message.body) || !isJsonNumber(message.body.n))
			throw new Error("expected numeric body");
		observed.push(message.body.n);
	});
	expect(observed).toEqual([1]);
});

it.each([
	"__proto__",
	"constructor",
	"toString",
])("keeps queue %s as an own entry", async (name) => {
	const runtime = createRuntimeLocalQueueClock();
	const queue = parseQueueName(name);
	await runtime.queue.enqueue(
		queue,
		{ n: 1 },
		{ idempotencyKey: parseIdempotencyKey("item") },
	);
	const report = await runtime.queue.handle(queue, async () => {});
	expect(report.handled).toHaveLength(1);
	expect(Object.hasOwn(runtime.snapshot().queues, name)).toBe(true);
	const restored = createRuntimeLocalQueueClock({
		snapshot: runtime.snapshot(),
	});
	await restored.queue.enqueue(
		queue,
		{ n: 2 },
		{ idempotencyKey: parseIdempotencyKey("next") },
	);
	expect(
		(await restored.queue.handle(queue, async () => {})).handled,
	).toHaveLength(1);
});
