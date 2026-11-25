/**
 * Replaying a recorded run that used crons.
 *
 * `replay-clock-trace.test.ts` covers the sleep-timer half of the determinism
 * gate. Crons are the other half, and they are the harder one: a sleep fires
 * once and is done, while a cron keeps firing for as long as the clock
 * advances. A replay therefore has to reproduce not just *which* schedules
 * fired but *how many times each did* — and getting the count wrong is the
 * failure a replay is least likely to notice, because every individual fire
 * looks correct.
 *
 * The properties are the same ones the sleep half rests on, applied to a
 * repeating source:
 *
 * **Occurrence numbers are part of the trace, not derived at replay.** A
 * schedule's third fire is a different fact from its first. Renumbering during
 * replay would let a replay that dropped a fire still line up, which is exactly
 * the divergence the gate exists to catch.
 *
 * **A cron and a timer that fire at the same instant keep their recorded
 * order.** Order is what makes a trace evidence rather than a set. Two fires at
 * one instant are the case where an implementation is most tempted to treat
 * ordering as arbitrary.
 *
 * **Divergence refuses rather than returning the replay's own answer.** A
 * replay that quietly reported what it produced would launder a mismatch into
 * a result someone would trust.
 *
 * The clock advances only when told to, so nothing here depends on wall time.
 */
import {
	NondeterministicClockError,
	parseRunId,
	parseScheduleId,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	createRuntimeLocalQueueClock,
	replayClockTrace,
} from "../src/replay.js";

/** Run a clock, returning its recorded trace. */
function recorded(
	drive: (clock: ReturnType<typeof createRuntimeLocalQueueClock>) => void,
	seed = "cron-seed",
) {
	const live = createRuntimeLocalQueueClock({
		seed,
		startInstant: "2026-01-01T00:00:00.000Z",
	});
	drive(live);
	return live.snapshot().trace;
}

const RUN = parseRunId("run-1");
/**
 * The instant every trace here starts at.
 *
 * `startAtMs` on a cron is an *absolute* epoch instant, not an offset from
 * now — a schedule given a small number starts in 1970, and the first advance
 * then has to catch up decades of occurrences one interval at a time. That is
 * consistent (the schedule says what it says) but it is a foot-gun worth
 * naming: offsets in these tests are computed from this constant.
 */
const START_MS = Date.parse("2026-01-01T00:00:00.000Z");
const NIGHTLY = parseScheduleId("nightly");
const HOURLY = parseScheduleId("hourly");

describe("replaying a cron", () => {
	it("replays a schedule that fired once", () => {
		const trace = recorded((live) => {
			live.clock.cron(NIGHTLY, { everyMs: 1_000 });
			live.clock.advance(1_000);
		});
		expect(replayClockTrace(trace).fireOrder).toStrictEqual(["cron:nightly:1"]);
	});

	it("reproduces every occurrence, not just the first", () => {
		// The count is the fact a replay is least likely to notice getting
		// wrong, because each individual fire still looks correct.
		const trace = recorded((live) => {
			live.clock.cron(NIGHTLY, { everyMs: 1_000 });
			live.clock.advance(3_000);
		});
		expect(replayClockTrace(trace).fireOrder).toStrictEqual([
			"cron:nightly:1",
			"cron:nightly:2",
			"cron:nightly:3",
		]);
	});

	it("replays a schedule that has not fired yet", () => {
		// A cron registered but never reached is still a recorded fact; a
		// replay that dropped it would diverge as soon as the clock advanced.
		const trace = recorded((live) => {
			live.clock.cron(NIGHTLY, { everyMs: 10_000 });
			live.clock.advance(1_000);
		});
		expect(replayClockTrace(trace).fireOrder).toStrictEqual([]);
	});

	it("replays a schedule with an explicit start offset", () => {
		// `startAtMs` shifts every subsequent fire, so a replay that defaulted
		// it would produce the right number of fires at the wrong instants.
		const trace = recorded((live) => {
			live.clock.cron(NIGHTLY, { everyMs: 1_000, startAtMs: START_MS + 2_500 });
			live.clock.advance(4_000);
		});
		expect(replayClockTrace(trace).fireOrder).toStrictEqual([
			"cron:nightly:1",
			"cron:nightly:2",
		]);
	});

	it("keeps two schedules apart", () => {
		// Fires come out in time order across schedules, not grouped by
		// schedule — and the two that land on the same instant (`hourly:1` and
		// `nightly:3`, both at t=3000) have a fixed tie-break rather than an
		// arbitrary one. Pinned as observed: a replay that resolved the tie the
		// other way would diverge from a live run that did not.
		const trace = recorded((live) => {
			live.clock.cron(NIGHTLY, { everyMs: 1_000 });
			live.clock.cron(HOURLY, { everyMs: 3_000 });
			live.clock.advance(3_000);
		});
		expect(replayClockTrace(trace).fireOrder).toStrictEqual([
			"cron:nightly:1",
			"cron:nightly:2",
			"cron:hourly:1",
			"cron:nightly:3",
		]);
	});

	it("replays a re-registration as the dedupe the live run recorded", () => {
		// Registering the same schedule id twice dedupes live. A replay that
		// registered it twice would double every fire.
		const trace = recorded((live) => {
			live.clock.cron(NIGHTLY, { everyMs: 1_000 });
			live.clock.cron(NIGHTLY, { everyMs: 1_000 });
			live.clock.advance(2_000);
		});
		expect(replayClockTrace(trace).fireOrder).toStrictEqual([
			"cron:nightly:1",
			"cron:nightly:2",
		]);
	});

	it("reports the final instant it reached", () => {
		const trace = recorded((live) => {
			live.clock.cron(NIGHTLY, { everyMs: 1_000 });
			live.clock.advance(3_000);
		});
		expect(replayClockTrace(trace).finalNow).toBe("2026-01-01T00:00:03.000Z");
	});

	it("is repeatable — two replays of one trace agree", () => {
		// Determinism is the whole claim. A replay that varied between runs
		// would make the gate itself unreliable evidence.
		const trace = recorded((live) => {
			live.clock.cron(NIGHTLY, { everyMs: 1_000 });
			live.clock.advance(3_000);
		});
		expect(replayClockTrace(trace)).toStrictEqual(replayClockTrace(trace));
	});
});

describe("crons and timers together", () => {
	it("keeps the recorded order across both kinds", () => {
		// Order is what makes a trace evidence rather than a set.
		const trace = recorded((live) => {
			live.clock.cron(NIGHTLY, { everyMs: 1_000 });
			live.clock.sleep(RUN, 1_500, { idempotencyKey: "k1" });
			live.clock.advance(2_000);
		});
		const replayed = replayClockTrace(trace).fireOrder;
		expect(replayed).toHaveLength(3);
		expect(replayed[0]).toBe("cron:nightly:1");
	});

	it("replays a cron and a timer that fire at the same instant", () => {
		// The case where an implementation is most tempted to treat ordering as
		// arbitrary — and where a replay diverging is hardest to spot.
		const trace = recorded((live) => {
			live.clock.cron(NIGHTLY, { everyMs: 1_000 });
			live.clock.sleep(RUN, 1_000, { idempotencyKey: "k1" });
			live.clock.advance(1_000);
		});
		expect(replayClockTrace(trace).fireOrder).toHaveLength(2);
	});

	it("replays across several advances", () => {
		// Fires are attributed to the advance that produced them, so batching
		// them differently would change the recorded order.
		const trace = recorded((live) => {
			live.clock.cron(NIGHTLY, { everyMs: 1_000 });
			live.clock.advance(1_000);
			live.clock.sleep(RUN, 500, { idempotencyKey: "k1" });
			live.clock.advance(1_000);
		});
		expect(replayClockTrace(trace).fireOrder).toHaveLength(3);
	});

	it("does not mutate the trace it was given", () => {
		// The caller's trace is evidence. A replay that consumed or reordered
		// it in place would make a second replay of the same array a different
		// question.
		const trace = recorded((live) => {
			live.clock.cron(NIGHTLY, { everyMs: 1_000 });
			live.clock.advance(2_000);
		});
		const before = JSON.stringify(trace);
		replayClockTrace(trace);
		expect(JSON.stringify(trace)).toBe(before);
	});
});

describe("cron traces it refuses", () => {
	it("refuses a trace missing a cron fire the replay produces", () => {
		// The replay fires three times; the trace records two. Returning the
		// replay's own answer here would launder the mismatch into a result
		// someone would trust.
		const trace = recorded((live) => {
			live.clock.cron(NIGHTLY, { everyMs: 1_000 });
			live.clock.advance(3_000);
		});
		const truncated = trace.filter(
			(entry) =>
				!(entry.type === "cron.fired" && entry.fireId === "cron:nightly:3"),
		);
		expect(() => replayClockTrace(truncated)).toThrow(
			NondeterministicClockError,
		);
	});

	it("refuses a trace carrying a cron fire the replay does not produce", () => {
		const trace = recorded((live) => {
			live.clock.cron(NIGHTLY, { everyMs: 1_000 });
			live.clock.advance(1_000);
		});
		const invented = [
			...trace,
			{
				type: "cron.fired" as const,
				fireId: "cron:nightly:2",
				scheduleId: "nightly",
				occurrence: 2,
				atMs: 2_000,
				order: 99,
			},
		];
		// SAFETY: the fixture builds a wire-shaped trace entry.
		expect(() => replayClockTrace(invented as never)).toThrow(
			/diverged from live trace/,
		);
	});

	it("refuses a trace whose occurrence numbers were renumbered", () => {
		// A schedule's third fire is a different fact from its first.
		// Renumbering at replay would let a replay that dropped a fire still
		// line up — the exact divergence the gate exists to catch.
		const trace = recorded((live) => {
			live.clock.cron(NIGHTLY, { everyMs: 1_000 });
			live.clock.advance(2_000);
		});
		const renumbered = trace.map((entry) =>
			entry.type === "cron.fired" ? { ...entry, occurrence: 1 } : entry,
		);
		// SAFETY: the fixture builds a wire-shaped trace entry.
		expect(() => replayClockTrace(renumbered as never)).toThrow(
			NondeterministicClockError,
		);
	});

	it("refuses a trace whose cron interval was edited", () => {
		// Editing the schedule changes what the replay produces while leaving
		// the recorded fires alone, so the two no longer describe one run.
		const trace = recorded((live) => {
			live.clock.cron(NIGHTLY, { everyMs: 1_000 });
			live.clock.advance(3_000);
		});
		const edited = trace.map((entry) =>
			entry.type === "cron.scheduled" ? { ...entry, everyMs: 2_000 } : entry,
		);
		// SAFETY: the fixture builds a wire-shaped trace entry.
		expect(() => replayClockTrace(edited as never)).toThrow(
			NondeterministicClockError,
		);
	});

	it("refuses a seed that does not match a cron trace", () => {
		// The seed is the source of determinism; replaying under a different
		// one produces a valid-looking result unrelated to the recorded run.
		const trace = recorded((live) => {
			live.clock.cron(NIGHTLY, { everyMs: 1_000 });
			live.clock.advance(1_000);
		}, "seed-a");
		expect(() => replayClockTrace(trace, { seed: "seed-b" })).toThrow(
			/seed mismatch/,
		);
	});
});
