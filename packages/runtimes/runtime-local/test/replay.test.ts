import { NondeterministicClockError, parseRunId } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	createRuntimeLocalQueueClock,
	replayClockTrace,
} from "../src/replay.js";

describe("replayClockTrace", () => {
	it("reproduces live fire order for seeded traces", () => {
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

		runtime.clock.advance(10);
		runtime.clock.advance(20);
		const replay = replayClockTrace(runtime.clock.trace(), {
			seed: "checkout-seed",
		});

		expect(replay.fireOrder).toEqual(["timer:timer-2", "timer:timer-1"]);
	});

	it("rejects seed mismatch before accepting a nondeterministic trace", () => {
		const runtime = createRuntimeLocalQueueClock({ seed: "expected-seed" });
		runtime.clock.sleep(parseRunId("run:one"), 1, {
			idempotencyKey: "sleep-one",
		});
		runtime.clock.advance(1);

		expect(() =>
			replayClockTrace(runtime.clock.trace(), { seed: "ambient-seed" }),
		).toThrow(NondeterministicClockError);
	});

	it("rejects same-seed traces with divergent fire ordering", () => {
		const runtime = createRuntimeLocalQueueClock({ seed: "expected-seed" });
		runtime.clock.sleep(parseRunId("run:slow"), 30, {
			idempotencyKey: "sleep-slow",
		});
		runtime.clock.sleep(parseRunId("run:fast"), 10, {
			idempotencyKey: "sleep-fast",
		});
		runtime.clock.advance(30);
		const tamperedTrace = runtime.clock
			.trace()
			.map((entry) =>
				entry.type === "timer.fired" && entry.fireId === "timer:timer-1"
					? { ...entry, fireId: "timer:timer-999" }
					: entry,
			);

		expect(() =>
			replayClockTrace(tamperedTrace, { seed: "expected-seed" }),
		).toThrow(NondeterministicClockError);
	});

	it("rejects same-seed traces with mutated fire timestamps", () => {
		const runtime = createRuntimeLocalQueueClock({ seed: "expected-seed" });
		runtime.clock.sleep(parseRunId("run:one"), 10, {
			idempotencyKey: "sleep-one",
		});
		runtime.clock.advance(10);
		const tamperedTrace = runtime.clock
			.trace()
			.map((entry) =>
				entry.type === "timer.fired"
					? { ...entry, atMs: entry.atMs + 1 }
					: entry,
			);

		expect(() =>
			replayClockTrace(tamperedTrace, { seed: "expected-seed" }),
		).toThrow(NondeterministicClockError);
	});
});
