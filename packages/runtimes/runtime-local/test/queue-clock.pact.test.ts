import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	NondeterministicClockError,
	parseIdempotencyKey,
	parseLeaseId,
	parseMessageId,
	parseQueueName,
	parseRunId,
	QueueLeaseLostError,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	createRuntimeLocalQueueClock,
	replayClockTrace,
} from "../src/replay.js";

const pactPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"contracts",
	"pacts",
	"queue-clock-port.pact.json",
);

describe("queue-clock-port pact", () => {
	it("satisfies hobo-runtime-sdk consumer interactions against runtime-local Queue + Clock", async () => {
		const pact = JSON.parse(readFileSync(pactPath, "utf8"));

		expect(pact.consumer.name).toBe("hobo-runtime-sdk");
		expect(pact.provider.name).toBe("@hobo/runtime-local");

		const runtime = createRuntimeLocalQueueClock();
		const queue = parseQueueName("jobs");
		const key = parseIdempotencyKey("job-1");
		const first = await runtime.queue.enqueue(
			queue,
			{ task: "send" },
			{ idempotencyKey: key },
		);
		const retry = await runtime.queue.enqueue(
			queue,
			{ task: "send" },
			{ idempotencyKey: key },
		);

		expect(first).toMatchObject({
			messageId: "msg-1",
			idempotencyKey: "job-1",
			deduped: false,
		});
		expect(retry.deduped).toBe(true);

		const leased = runtime.queue.dequeue(queue);
		const messageId = leased[0]?.messageId ?? parseMessageId("msg-1");
		expect(() =>
			runtime.queue.complete(messageId, parseLeaseId("lease-wrong")),
		).toThrow(QueueLeaseLostError);

		const seeded = createRuntimeLocalQueueClock({ seed: "expected-seed" });
		seeded.clock.sleep(parseRunId("run:one"), 1, {
			idempotencyKey: "sleep-one",
		});
		seeded.clock.advance(1);
		expect(() =>
			replayClockTrace(seeded.clock.trace(), { seed: "wrong-seed" }),
		).toThrow(NondeterministicClockError);
	});
});
