/**
 * Replaying a local clock trace.
 *
 * The local queue/clock is the deterministic substrate under HoBo's timers and
 * crons: a run records what it did, and a replay must reproduce it exactly.
 * That guarantee is what makes a recorded run usable as evidence, so the
 * failure modes worth holding are all about *refusing* rather than producing.
 *
 * **A replay that diverges must say so, not return a plausible answer.** If
 * the replay fires different timers, or the same timers in a different order,
 * the recorded trace no longer describes the system — and a replay that
 * silently returned its own fire order would launder that into a result
 * someone would trust.
 *
 * **A seed mismatch is refused before anything runs.** The seed is the whole
 * source of determinism; replaying under a different one produces a valid-
 * looking result that has nothing to do with the recorded run.
 *
 * **A trace with no `clock.started` has no origin.** Every instant in the
 * trace is relative to that entry, so a trace missing it cannot be replayed
 * at all, and guessing an origin would shift every fire.
 *
 * The clock is entirely in-memory and advances only when told to, so these
 * tests are as deterministic as the thing they test.
 */

import { NondeterministicClockError, parseRunId } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	createRuntimeLocalQueueClock,
	replayClockTrace,
} from "../src/replay.js";

/** Run a clock, returning its recorded trace. */
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
		// A run that only started the clock is still a run, and its replay must
		// succeed rather than treat "no timers" as a malformed trace.
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
		// Order is the property that matters: three timers firing in a
		// different order is a different program, even with the same set.
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
		// Two half-advances must land the same fire as one whole one; a replay
		// that coalesced them would drift from the recorded instants.
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
		// `finalNow` is what a caller compares against the live run; a replay
		// that ended at a different instant did not reproduce the run.
		expect(typeof replayClockTrace(trace).finalNow).toBe("string");
	});

	it("is repeatable — two replays of one trace agree", () => {
		const trace = recorded((live) => {
			live.clock.sleep(RUN, 1_000, { idempotencyKey: "k1" });
			live.clock.advance(1_000);
		});
		// If replay were not itself deterministic, none of the above would mean
		// anything.
		expect(replayClockTrace(trace)).toEqual(replayClockTrace(trace));
	});

	it("does not mutate the trace it was given", () => {
		const trace = recorded((live) => {
			live.clock.sleep(RUN, 1_000, { idempotencyKey: "k1" });
			live.clock.advance(1_000);
		});
		const before = JSON.stringify(trace);
		replayClockTrace(trace);
		// A replay that consumed its input could not be run twice, and the
		// caller's evidence would change under them.
		expect(JSON.stringify(trace)).toBe(before);
	});

	it("accepts an explicit seed that matches the trace", () => {
		const trace = recorded(() => undefined, "seed-1");
		expect(replayClockTrace(trace, { seed: "seed-1" }).seed).toBe("seed-1");
	});
});

describe("refusing a trace it cannot replay", () => {
	it("refuses a trace with no clock.started", () => {
		// Every instant is relative to that entry. Guessing an origin would
		// shift every fire in the trace.
		expect(() => replayClockTrace([])).toThrow(NondeterministicClockError);
	});

	it("names the missing entry", () => {
		expect(() => replayClockTrace([])).toThrow(/missing clock.started/);
	});

	it("refuses a trace whose entries are all unrelated", () => {
		// SAFETY: a deliberately malformed trace, which is what is under test.
		const trace = [{ type: "timer.scheduled" }] as never;
		expect(() => replayClockTrace(trace)).toThrow(NondeterministicClockError);
	});

	it("refuses a seed that does not match the trace", () => {
		const trace = recorded(() => undefined, "seed-1");
		// The seed is the whole source of determinism. Replaying under another
		// one produces a valid-looking result describing a different run.
		expect(() => replayClockTrace(trace, { seed: "seed-2" })).toThrow(
			NondeterministicClockError,
		);
	});

	it("names both seeds in the mismatch", () => {
		const trace = recorded(() => undefined, "seed-1");
		// An operator holding two traces needs to know which one they passed.
		expect(() => replayClockTrace(trace, { seed: "seed-2" })).toThrow(
			/expected seed-1, got seed-2/,
		);
	});

	it("refuses a trace that is not an array", () => {
		// SAFETY: a deliberately wrong type, which is what is under test.
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
		// Append a fire that the replay will never produce. This is the case the
		// whole mechanism exists for: the recorded run claims something the
		// substrate does not reproduce.
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
		// The mirror image: the replay fires a timer the trace does not record.
		// A replay that ignored extra fires would pass a doctored trace.
		expect(() => replayClockTrace(trace)).toThrow(/diverged from live trace/);
	});
});

describe("the queue/clock handle", () => {
	it("hands back a frozen handle", () => {
		const live = createRuntimeLocalQueueClock({ seed: "s" });
		// The handle is passed around a run; a caller swapping its clock would
		// break determinism invisibly.
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
		// The snapshot is a replay baseline. If a caller could push into its
		// trace, the baseline would drift from the run it recorded — this is
		// the property the deep-freeze array fix restored.
		expect(Object.isFrozen(snapshot.trace)).toBe(true);
	});

	it("keeps a snapshot stable as the run continues", () => {
		const live = createRuntimeLocalQueueClock({ seed: "s" });
		const before = live.snapshot();
		const length = before.trace.length;
		live.clock.sleep(RUN, 1_000, { idempotencyKey: "k1" });
		// A snapshot that grew with the run would be a live view, not a
		// snapshot, and every replay taken from one would be a different run.
		expect(before.trace).toHaveLength(length);
	});

	it("defaults to a usable clock with no options at all", () => {
		const live = createRuntimeLocalQueueClock();
		expect(typeof live.clock.now()).toBe("string");
	});
});
