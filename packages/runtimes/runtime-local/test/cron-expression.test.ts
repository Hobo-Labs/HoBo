import { parseScheduleId, SCHEDULER_PORT } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createRuntimeLocalQueueClock,
	replayClockTrace,
} from "../src/replay.js";
import { createLocalScheduler } from "../src/scheduler.js";

describe("cron expression schedules", () => {
	it("runs every due occurrence and replays the same fire order", () => {
		const runtime = createRuntimeLocalQueueClock({
			seed: "cron",
			startInstant: "2030-01-01T00:00:00.000Z",
		});
		const scheduler = createLocalScheduler(runtime.clock);
		const observed: string[] = [];
		const schedule = scheduler.registerCronJob(
			parseScheduleId("quarter-hour"),
			{ expression: "*/15 * * * *", timezone: "UTC" },
			(fire) => observed.push(fire.at),
		);
		expect(schedule.nextFireAt).toBe("2030-01-01T00:15:00.000Z");
		const fired = scheduler.advance(50 * 60_000);
		expect(observed).toEqual([
			"2030-01-01T00:15:00.000Z",
			"2030-01-01T00:30:00.000Z",
			"2030-01-01T00:45:00.000Z",
		]);
		expect(replayClockTrace(runtime.clock.trace()).fireOrder).toEqual(
			fired.map((fire) => fire.fireId),
		);
	});

	it("restores the next fire and lets a handler reattach after a snapshot", () => {
		const runtime = createRuntimeLocalQueueClock({
			seed: "cron",
			startInstant: "2030-01-01T00:00:00.000Z",
		});
		const id = parseScheduleId("nightly");
		const spec = { expression: "0 3 * * *", timezone: "UTC" };
		createLocalScheduler(runtime.clock).cron(id, spec);
		runtime.clock.advance(4 * 3_600_000);
		const restored = createRuntimeLocalQueueClock({
			snapshot: runtime.snapshot(),
		});
		const scheduler = createLocalScheduler(restored.clock);
		const observed: string[] = [];
		const schedule = scheduler.registerCronJob(id, spec, (fire) =>
			observed.push(fire.at),
		);
		expect(schedule.deduped).toBe(true);
		expect(schedule.nextFireAt).toBe("2030-01-02T03:00:00.000Z");
		scheduler.advance(23 * 3_600_000);
		expect(observed).toEqual(["2030-01-02T03:00:00.000Z"]);
		expect(replayClockTrace(restored.clock.trace()).fireOrder).toEqual([
			"cron:nightly:1",
			"cron:nightly:2",
		]);
	});

	it("uses the requested timezone across daylight saving changes", () => {
		const runtime = createRuntimeLocalQueueClock({
			startInstant: "2026-03-07T12:00:00.000Z",
		});
		const scheduler = createLocalScheduler(runtime.clock);
		scheduler.cron(parseScheduleId("morning"), {
			expression: "0 9 * * *",
			timezone: "America/New_York",
		});
		expect(scheduler.advance(26 * 3_600_000).map((fire) => fire.at)).toEqual([
			"2026-03-07T14:00:00.000Z",
			"2026-03-08T13:00:00.000Z",
		]);
	});

	it("uses standard day-of-month and day-of-week matching", () => {
		const runtime = createRuntimeLocalQueueClock({
			startInstant: "2029-12-31T23:59:00.000Z",
		});
		const scheduler = createLocalScheduler(runtime.clock);
		scheduler.cron(parseScheduleId("calendar"), {
			expression: "0 0 1 * 1",
			timezone: "UTC",
		});
		expect(scheduler.advance(7 * 86_400_000).map((fire) => fire.at)).toEqual([
			"2030-01-01T00:00:00.000Z",
			"2030-01-07T00:00:00.000Z",
		]);
	});

	it("rejects a trace with an altered cron registration time", () => {
		const runtime = createRuntimeLocalQueueClock();
		createLocalScheduler(runtime.clock).cron(parseScheduleId("nightly"), {
			expression: "0 3 * * *",
			timezone: "UTC",
		});
		const trace = runtime.clock
			.trace()
			.map((entry) =>
				entry.type === "cron.expression-scheduled"
					? { ...entry, startAtMs: entry.startAtMs + 1 }
					: entry,
			);
		expect(() => replayClockTrace(trace)).toThrow(/registration time/);
	});

	it("exposes a WIT-compatible cron reference and deterministic default id", () => {
		const runtime = createRuntimeLocalQueueClock({
			startInstant: "2030-01-01T00:00:00.000Z",
		});
		const port = createLocalScheduler(runtime.clock).providerExports()[
			SCHEDULER_PORT
		];
		if (!port) throw new Error("scheduler port missing");
		const first = port.cron("*/5 * * * *");
		const second = port.cron("*/5 * * * *");
		expect(first.spec).toEqual({
			tag: "cron",
			val: { expr: "*/5 * * * *", timezone: "UTC" },
		});
		expect(second.scheduleId).toBe(first.scheduleId);
		expect(second.deduped).toBe(true);
		expect(runtime.clock.advance(5 * 60_000)).toHaveLength(1);
	});

	it("rejects invalid expressions, timezones, and conflicting schedule ids", () => {
		const runtime = createRuntimeLocalQueueClock();
		const scheduler = createLocalScheduler(runtime.clock);
		const id = parseScheduleId("same");
		const before = runtime.snapshot();
		expect(() =>
			scheduler.cron(id, { expression: "not a cron", timezone: "UTC" }),
		).toThrow(TypeError);
		expect(() =>
			scheduler.cron(id, { expression: "0 0 31 2 *", timezone: "UTC" }),
		).toThrow(TypeError);
		expect(() =>
			scheduler.cron(id, { expression: "* * * * *", timezone: "not/a-zone" }),
		).toThrow(TypeError);
		expect(runtime.snapshot()).toEqual(before);
		scheduler.cron(id, { expression: "* * * * *", timezone: "UTC" });
		expect(() =>
			scheduler.cron(id, { expression: "*/5 * * * *", timezone: "UTC" }),
		).toThrow(/another recurrence/);
		expect(() => scheduler.every(id, { everyMs: 1_000 })).toThrow(
			/cron expression/,
		);
	});
});
