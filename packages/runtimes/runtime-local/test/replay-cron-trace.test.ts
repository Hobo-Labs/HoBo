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
		const trace = recorded((live) => {
			live.clock.cron(NIGHTLY, { everyMs: 10_000 });
			live.clock.advance(1_000);
		});
		expect(replayClockTrace(trace).fireOrder).toStrictEqual([]);
	});

	it("replays a schedule with an explicit start offset", () => {
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
		const trace = recorded((live) => {
			live.clock.cron(NIGHTLY, { everyMs: 1_000 });
			live.clock.advance(3_000);
		});
		expect(replayClockTrace(trace)).toStrictEqual(replayClockTrace(trace));
	});
});

describe("crons and timers together", () => {
	it("keeps the recorded order across both kinds", () => {
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
		const trace = recorded((live) => {
			live.clock.cron(NIGHTLY, { everyMs: 1_000 });
			live.clock.sleep(RUN, 1_000, { idempotencyKey: "k1" });
			live.clock.advance(1_000);
		});
		expect(replayClockTrace(trace).fireOrder).toHaveLength(2);
	});

	it("replays across several advances", () => {
		const trace = recorded((live) => {
			live.clock.cron(NIGHTLY, { everyMs: 1_000 });
			live.clock.advance(1_000);
			live.clock.sleep(RUN, 500, { idempotencyKey: "k1" });
			live.clock.advance(1_000);
		});
		expect(replayClockTrace(trace).fireOrder).toHaveLength(3);
	});

	it("does not mutate the trace it was given", () => {
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
		const trace = recorded((live) => {
			live.clock.cron(NIGHTLY, { everyMs: 1_000 });
			live.clock.advance(1_000);
		}, "seed-a");
		expect(() => replayClockTrace(trace, { seed: "seed-b" })).toThrow(
			/seed mismatch/,
		);
	});
});
