import { parseRunId } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createRuntimeLocalQueueClock,
	replayClockTrace,
} from "../../runtimes/runtime-local/src/index.js";
import { runRedeliveryAfterCrash } from "../fixtures/runtime-ports/redelivery-after-crash.js";
import {
	assertMutatedFireFactRejects,
	assertSeedMismatchRejects,
	runTimeTravelReplay,
} from "../fixtures/runtime-ports/time-travel-replay.js";
import { runQueueClockConformance } from "../src/queue-clock.js";

describe("@hobo/conformance Queue + Clock suite", () => {
	it("reports pass for every runtime-local assertion", async () => {
		const report = await runQueueClockConformance(
			createRuntimeLocalQueueClock,
			{
				replayClockTrace,
			},
		);

		expect(report).toEqual({
			contract: "hobo.queue-clock-runtime-port/v1",
			backend: "runtime-local",
			assertions: {
				queueIdempotencyKeyDedup: "pass",
				atLeastOnceRetry: "pass",
				redeliveryDedup: "pass",
				durableTimerRestart: "pass",
				durableCronRestart: "pass",
				seededClockReplay: "pass",
			},
		});
	});

	it("redelivery-after-crash fixture keeps effect count at 1 across snapshot restore", async () => {
		const result = await runRedeliveryAfterCrash(createRuntimeLocalQueueClock);

		expect(result.effectCount).toBe(1);
		expect(result.messageCompleted).toBe(true);
	});

	it("time-travel-replay fixture reproduces live fire order and facts", () => {
		const result = runTimeTravelReplay(
			createRuntimeLocalQueueClock,
			replayClockTrace,
		);

		expect(result.liveFires.length).toBeGreaterThanOrEqual(2);
		expect(result.replayFireOrder.length).toBeGreaterThanOrEqual(2);
		expect(result.replayMatchesLive).toBe(true);
	});

	it("time-travel-replay fixture rejects seed mismatch", () => {
		const runtime = createRuntimeLocalQueueClock({
			seed: "time-travel-seed",
			startInstant: "2026-06-26T00:00:00.000Z",
		});
		runtime.clock.sleep(parseRunId("run:one"), 10, {
			idempotencyKey: "sleep-one",
		});
		runtime.clock.advance(10);

		expect(
			assertSeedMismatchRejects(runtime.clock.trace(), replayClockTrace),
		).toBe(true);
	});

	it("time-travel-replay fixture rejects mutated fire timestamps", () => {
		const runtime = createRuntimeLocalQueueClock({
			seed: "time-travel-seed",
			startInstant: "2026-06-26T00:00:00.000Z",
		});
		runtime.clock.sleep(parseRunId("run:one"), 10, {
			idempotencyKey: "sleep-one",
		});
		runtime.clock.advance(10);

		expect(
			assertMutatedFireFactRejects(runtime.clock.trace(), replayClockTrace),
		).toBe(true);
	});
});
