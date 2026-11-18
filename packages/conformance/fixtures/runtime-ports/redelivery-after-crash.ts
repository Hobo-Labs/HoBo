import { parseIdempotencyKey, parseQueueName } from "@hobo/core";
import type { CreateRuntimeLocalQueueClock } from "../../src/queue-clock.js";

export interface RedeliveryAfterCrashResult {
	effectCount: number;
	messageCompleted: boolean;
	messageId: string;
}

export async function runRedeliveryAfterCrash<Snapshot>(
	createRuntime: CreateRuntimeLocalQueueClock<Snapshot>,
): Promise<RedeliveryAfterCrashResult> {
	const effectLedger = new Set<string>();
	const recordEffect = (idempotencyKey: string) => {
		effectLedger.add(idempotencyKey);
	};

	const runtime = createRuntime({ seed: "redelivery-crash" });
	const queue = parseQueueName("jobs");
	const key = parseIdempotencyKey("job-crash-1");
	const enqueued = await runtime.queue.enqueue(
		queue,
		{ task: "charge" },
		{ idempotencyKey: key },
	);

	let crashed = false;
	try {
		await runtime.queue.handle(queue, async (message) => {
			recordEffect(message.idempotencyKey);
			throw new Error("crash before complete");
		});
	} catch (error) {
		if (!(error instanceof Error) || error.message !== "crash before complete")
			throw error;
		crashed = true;
	}
	if (!crashed) throw new Error("handler did not report the simulated crash");

	const restored = createRuntime({ snapshot: runtime.snapshot() });
	const redelivery = await restored.queue.handle(queue, async (message) => {
		recordEffect(message.idempotencyKey);
	});

	return {
		effectCount: effectLedger.size,
		messageCompleted: redelivery.handled.includes(enqueued.messageId),
		messageId: enqueued.messageId,
	};
}
