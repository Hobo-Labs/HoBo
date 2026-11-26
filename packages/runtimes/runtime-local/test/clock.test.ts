import { parseRunId, parseScheduleId } from "@hobo/core";
import { describe, expect, it } from "vitest";

import { createRuntimeLocalQueueClock } from "../src/replay.js";

describe("createRuntimeLocalQueueClock clock", () => {
	it("durable sleep survives simulated restart and fires once", () => {
		const runtime = createRuntimeLocalQueueClock({
			seed: "timer-restart",
			startInstant: "2026-06-26T00:00:00.000Z",
		});
		const timer = runtime.clock.sleep(parseRunId("run:checkout"), 1_000, {
			idempotencyKey: "sleep-checkout",
		});
		const restarted = createRuntimeLocalQueueClock({
			snapshot: runtime.snapshot(),
		});

		const fired = restarted.clock.advance(1_000);
		const afterFireRestart = createRuntimeLocalQueueClock({
			snapshot: restarted.snapshot(),
		});

		expect(
			fired.map((event) => [event.kind, event.timerId, event.runId]),
		).toEqual([["sleep", timer.timerId, parseRunId("run:checkout")]]);
		expect(restarted.clock.advance(0)).toEqual([]);
		expect(afterFireRestart.clock.advance(10_000)).toEqual([]);
	});

	it("deterministic cron interval persists occurrence ordering across restart", () => {
		const runtime = createRuntimeLocalQueueClock({
			seed: "cron-seed",
			startInstant: "2026-06-26T00:00:00.000Z",
		});
		runtime.clock.cron(parseScheduleId("heartbeat"), { everyMs: 1_000 });

		const firstWindow = runtime.clock.advance(3_000);
		const restarted = createRuntimeLocalQueueClock({
			snapshot: runtime.snapshot(),
		});
		const secondWindow = restarted.clock.advance(1_000);

		expect(firstWindow.map((event) => event.fireId)).toEqual([
			"cron:heartbeat:1",
			"cron:heartbeat:2",
			"cron:heartbeat:3",
		]);
		expect(secondWindow.map((event) => event.fireId)).toEqual([
			"cron:heartbeat:4",
		]);
	});

	it("pending cron schedule survives simulated restart and fires the first occurrence once", () => {
		const runtime = createRuntimeLocalQueueClock({
			seed: "cron-pending-seed",
			startInstant: "2026-06-26T00:00:00.000Z",
		});
		runtime.clock.cron(parseScheduleId("heartbeat"), { everyMs: 1_000 });
		const restarted = createRuntimeLocalQueueClock({
			snapshot: runtime.snapshot(),
		});

		const fired = restarted.clock.advance(1_000);
		const afterFireRestart = createRuntimeLocalQueueClock({
			snapshot: restarted.snapshot(),
		});

		expect(fired.map((event) => event.fireId)).toEqual(["cron:heartbeat:1"]);
		expect(afterFireRestart.clock.advance(0)).toEqual([]);
	});

	it("advance wakes sleeping runs in fire-at order", () => {
		const runtime = createRuntimeLocalQueueClock({
			seed: "checkout-seed",
			startInstant: "2026-06-26T00:00:00.000Z",
		});
		runtime.clock.sleep(parseRunId("run:slow"), 30, {
			idempotencyKey: "sleep-slow",
			label: "slow",
		});
		runtime.clock.sleep(parseRunId("run:fast"), 10, {
			idempotencyKey: "sleep-fast",
			label: "fast",
		});

		const firstAdvance = runtime.clock.advance(10);
		const secondAdvance = runtime.clock.advance(20);

		expect(
			[...firstAdvance, ...secondAdvance].map((event) => event.runId),
		).toEqual([parseRunId("run:fast"), parseRunId("run:slow")]);
	});
});
