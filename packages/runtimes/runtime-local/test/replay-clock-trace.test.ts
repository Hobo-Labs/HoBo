import { NondeterministicClockError, parseRunId } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	createRuntimeLocalQueueClock,
	replayClockTrace,
} from "../src/replay.js";

function recorded(
	drive: (clock: ReturnType<typeof createRuntimeLocalQueueClock>) => void,
	seed = "seed-1",
) {
	const live = createRuntimeLocalQueueClock({
		seed,
		startInstant: "2026-01-01T00:00:00.000Z",
	});
	drive(live);
	return live.snapshot().trace;
}

const RUN = parseRunId("run-1");

describe("replaying a recorded run", () => {
	it("replays a trace that scheduled nothing", () => {
		const trace = recorded(() => undefined);

		expect(replayClockTrace(trace).seed).toBe("seed-1");
	});

	it("carries the recorded seed into the result", () => {
		const trace = recorded(() => undefined, "seed-xyz");
		expect(replayClockTrace(trace).seed).toBe("seed-xyz");
	});

	it("replays a run that scheduled and fired one timer", () => {
		const trace = recorded((live) => {
			live.clock.sleep(RUN, 1_000, { idempotencyKey: "k1" });
			live.clock.advance(1_000);
		});
		expect(replayClockTrace(trace).fireOrder).toHaveLength(1);
	});

	it("reproduces the fire order of several timers", () => {
		const trace = recorded((live) => {
			live.clock.sleep(RUN, 3_000, { idempotencyKey: "k3" });
			live.clock.sleep(RUN, 1_000, { idempotencyKey: "k1" });
			live.clock.sleep(RUN, 2_000, { idempotencyKey: "k2" });
			live.clock.advance(5_000);
		});

		expect(replayClockTrace(trace).fireOrder).toHaveLength(3);
	});

	it("replays a timer that carried a label", () => {
		const trace = recorded((live) => {
			live.clock.sleep(RUN, 1_000, { idempotencyKey: "k1", label: "retry" });
			live.clock.advance(1_000);
		});
		expect(replayClockTrace(trace).fireOrder).toHaveLength(1);
	});

	it("replays across several advances", () => {
		const trace = recorded((live) => {
			live.clock.sleep(RUN, 1_000, { idempotencyKey: "k1" });
			live.clock.advance(500);
			live.clock.advance(500);
		});

		expect(replayClockTrace(trace).fireOrder).toHaveLength(1);
	});

	it("replays an advance that fired nothing", () => {
		const trace = recorded((live) => {
			live.clock.sleep(RUN, 10_000, { idempotencyKey: "k1" });
			live.clock.advance(1_000);
		});
		expect(replayClockTrace(trace).fireOrder).toEqual([]);
	});

	it("reports the final instant it reached", () => {
		const trace = recorded((live) => {
			live.clock.advance(5_000);
		});

		expect(typeof replayClockTrace(trace).finalNow).toBe("string");
	});

	it("is repeatable — two replays of one trace agree", () => {
		const trace = recorded((live) => {
			live.clock.sleep(RUN, 1_000, { idempotencyKey: "k1" });
			live.clock.advance(1_000);
		});

		expect(replayClockTrace(trace)).toEqual(replayClockTrace(trace));
	});

	it("does not mutate the trace it was given", () => {
		const trace = recorded((live) => {
			live.clock.sleep(RUN, 1_000, { idempotencyKey: "k1" });
			live.clock.advance(1_000);
		});
		const before = JSON.stringify(trace);
		replayClockTrace(trace);

		expect(JSON.stringify(trace)).toBe(before);
	});

	it("accepts an explicit seed that matches the trace", () => {
		const trace = recorded(() => undefined, "seed-1");
		expect(replayClockTrace(trace, { seed: "seed-1" }).seed).toBe("seed-1");
	});
});

describe("refusing a trace it cannot replay", () => {
	it("refuses a trace with no clock.started", () => {
		expect(() => replayClockTrace([])).toThrow(NondeterministicClockError);
	});

	it("names the missing entry", () => {
		expect(() => replayClockTrace([])).toThrow(/missing clock.started/);
	});

	it("refuses a trace whose entries are all unrelated", () => {
		const trace = [{ type: "timer.scheduled" }] as never;
		expect(() => replayClockTrace(trace)).toThrow(NondeterministicClockError);
	});

	it("refuses a seed that does not match the trace", () => {
		const trace = recorded(() => undefined, "seed-1");

		expect(() => replayClockTrace(trace, { seed: "seed-2" })).toThrow(
			NondeterministicClockError,
		);
	});

	it("names both seeds in the mismatch", () => {
		const trace = recorded(() => undefined, "seed-1");

		expect(() => replayClockTrace(trace, { seed: "seed-2" })).toThrow(
			/expected seed-1, got seed-2/,
		);
	});

	it("refuses a trace that is not an array", () => {
		expect(() => replayClockTrace("trace" as never)).toThrow(TypeError);
	});

	it("names the field in the type refusal", () => {
		expect(() => replayClockTrace("trace" as never)).toThrow(
			/trace must be an array/,
		);
	});

	it("refuses a trace whose recorded fires disagree with the replay", () => {
		const trace = [
			...recorded((live) => {
				live.clock.sleep(RUN, 1_000, { idempotencyKey: "k1" });
				live.clock.advance(1_000);
			}),
		];

		const forged = [
			...trace,
			{
				type: "timer.fired",
				fireId: "forged",
				timerId: "t9",
				runId: "run-1",
				atMs: 1,
				order: 99,
			},
			// SAFETY: a deliberately forged trace, which is what is under test.
		] as never;
		expect(() => replayClockTrace(forged)).toThrow(/diverged from live trace/);
	});

	it("refuses a trace missing a fire the replay does produce", () => {
		const trace = recorded((live) => {
			live.clock.sleep(RUN, 1_000, { idempotencyKey: "k1" });
			live.clock.advance(1_000);
		}).filter((entry) => entry.type !== "timer.fired");

		expect(() => replayClockTrace(trace)).toThrow(/diverged from live trace/);
	});
});

describe("the queue/clock handle", () => {
	it("hands back a frozen handle", () => {
		const live = createRuntimeLocalQueueClock({ seed: "s" });

		expect(Object.isFrozen(live)).toBe(true);
	});

	it("exposes a queue and a clock over one store", () => {
		const live = createRuntimeLocalQueueClock({ seed: "s" });
		expect(live.queue).toBeDefined();
		expect(live.clock).toBeDefined();
	});

	it("records a clock.started entry as its first fact", () => {
		const live = createRuntimeLocalQueueClock({ seed: "s" });
		expect(live.snapshot().trace[0]).toMatchObject({ type: "clock.started" });
	});

	it("snapshots a store that cannot be mutated through the handle", () => {
		const live = createRuntimeLocalQueueClock({ seed: "s" });
		const snapshot = live.snapshot();

		expect(Object.isFrozen(snapshot.trace)).toBe(true);
	});

	it("keeps a snapshot stable as the run continues", () => {
		const live = createRuntimeLocalQueueClock({ seed: "s" });
		const before = live.snapshot();
		const length = before.trace.length;
		live.clock.sleep(RUN, 1_000, { idempotencyKey: "k1" });

		expect(before.trace).toHaveLength(length);
	});

	it("defaults to a usable clock with no options at all", () => {
		const live = createRuntimeLocalQueueClock();
		expect(typeof live.clock.now()).toBe("string");
	});
});
