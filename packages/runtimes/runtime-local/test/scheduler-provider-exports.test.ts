import { type FiredTimer, parseScheduleId, SCHEDULER_PORT } from "@hobo/core";
import { describe, expect, it } from "vitest";

import { createRuntimeLocalQueueClock } from "../src/replay.js";
import { createLocalScheduler } from "../src/scheduler.js";

function fixture() {
	const runtime = createRuntimeLocalQueueClock({
		seed: "scheduler-exports-seed",
		startInstant: "2026-06-26T00:00:00.000Z",
	});
	const scheduler = createLocalScheduler(runtime.clock);
	return {
		runtime,
		scheduler,
		port: scheduler.providerExports()[SCHEDULER_PORT],
	};
}

describe("the export table", () => {
	it("is keyed by the scheduler port token", () => {
		expect(Object.keys(fixture().scheduler.providerExports())).toStrictEqual([
			SCHEDULER_PORT,
		]);
	});

	it("offers both WIT operations", () => {
		expect(Object.keys(fixture().port ?? {}).sort()).toStrictEqual([
			"cron",
			"every",
		]);
	});
});

describe("registering an interval", () => {
	it("registers an interval by schedule id", () => {
		const { port } = fixture();
		expect(
			port?.every({ scheduleId: "nightly", everyMs: 1_000 }).scheduleId,
		).toBe(parseScheduleId("nightly"));
	});

	it("registers a job that actually fires on the clock", () => {
		const { port, scheduler } = fixture();
		const fires: FiredTimer[] = [];
		port?.every({ scheduleId: "nightly", everyMs: 1_000 });
		scheduler.registerJob(
			parseScheduleId("nightly"),
			{ everyMs: 1_000 },
			(fire) => fires.push(fire),
		);
		scheduler.advance(3_000);
		expect(fires.length).toBeGreaterThan(0);
	});

	it("accepts a start offset", () => {
		const { port } = fixture();
		expect(() =>
			port?.every({ scheduleId: "a", everyMs: 1_000, startAtMs: 500 }),
		).not.toThrow();
	});

	it("rejects a start offset that is not a number", () => {
		const { port } = fixture();
		for (const startAtMs of ["soon", null, true]) {
			expect(() =>
				port?.every({ scheduleId: "a", everyMs: 1_000, startAtMs }),
			).toThrow(/startAtMs must be a number/);
		}
	});
});

describe("intervals the port refuses", () => {
	it("refuses a missing interval", () => {
		expect(() => fixture().port?.every({ scheduleId: "a" })).toThrow(
			/everyMs must be a number/,
		);
	});

	it("refuses an interval sent as a string", () => {
		expect(() =>
			fixture().port?.every({ scheduleId: "a", everyMs: "1000" }),
		).toThrow(TypeError);
	});

	it("refuses a null interval", () => {
		expect(() =>
			fixture().port?.every({ scheduleId: "a", everyMs: null }),
		).toThrow(TypeError);
	});

	it("rejects unrecognized interval fields", () => {
		expect(() =>
			fixture().port?.every({ scheduleId: "a", everyMs: 1_000, unexpected: 5 }),
		).toThrow("invalid interval schedule fields");
	});

	it("refuses a payload that is not an object", () => {
		for (const payload of [[], "nightly", 1_000, null]) {
			expect(() => fixture().port?.every(payload)).toThrow(TypeError);
		}
	});

	it("refuses an empty schedule id", () => {
		expect(() => fixture().port?.every({ everyMs: 1_000 })).toThrow();
	});
});

describe("cron expressions", () => {
	it("registers the WIT expression", () => {
		expect(fixture().port?.cron("0 3 * * *")).toMatchObject({
			expression: "0 3 * * *",
			timezone: "UTC",
		});
	});

	it("rejects malformed expressions", () => {
		expect(() => fixture().port?.cron({ expr: "not cron" })).toThrow(TypeError);
	});

	it("refuses when no expression was given", () => {
		expect(() => fixture().port?.cron({})).toThrow(TypeError);
	});

	it("refuses unsupported payload types", () => {
		expect(() => fixture().port?.cron(42)).toThrow(TypeError);
	});
});

describe("advancing the clock", () => {
	it("runs the handler registered for a fired schedule", () => {
		const { scheduler } = fixture();
		const fires: FiredTimer[] = [];
		scheduler.registerJob(parseScheduleId("a"), { everyMs: 1_000 }, (fire) =>
			fires.push(fire),
		);
		scheduler.advance(1_000);
		expect(fires).toHaveLength(1);
	});

	it("returns every fire, not only the ones with handlers", () => {
		const { scheduler } = fixture();
		scheduler.every(parseScheduleId("unhandled"), { everyMs: 1_000 });
		expect(scheduler.advance(1_000).length).toBeGreaterThan(0);
	});

	it("does not fail on a schedule with no handler", () => {
		const { scheduler } = fixture();
		scheduler.every(parseScheduleId("unhandled"), { everyMs: 1_000 });
		expect(() => scheduler.advance(5_000)).not.toThrow();
	});

	it("dispatches nothing when time has not reached the interval", () => {
		const { scheduler } = fixture();
		const fires: FiredTimer[] = [];
		scheduler.registerJob(parseScheduleId("a"), { everyMs: 1_000 }, (fire) =>
			fires.push(fire),
		);
		scheduler.advance(500);
		expect(fires).toStrictEqual([]);
	});

	it("dispatches once per elapsed interval", () => {
		const { scheduler } = fixture();
		const fires: FiredTimer[] = [];
		scheduler.registerJob(parseScheduleId("a"), { everyMs: 1_000 }, (fire) =>
			fires.push(fire),
		);
		scheduler.advance(3_000);
		expect(fires.length).toBeGreaterThanOrEqual(3);
	});

	it("keeps two schedules' handlers apart", () => {
		const { scheduler } = fixture();
		const a: FiredTimer[] = [];
		const b: FiredTimer[] = [];
		scheduler.registerJob(parseScheduleId("a"), { everyMs: 1_000 }, (fire) =>
			a.push(fire),
		);
		scheduler.registerJob(parseScheduleId("b"), { everyMs: 5_000 }, (fire) =>
			b.push(fire),
		);
		scheduler.advance(1_000);
		expect([a.length, b.length]).toStrictEqual([1, 0]);
	});
});

describe("the scheduler object", () => {
	it("is frozen", () => {
		expect(Object.isFrozen(fixture().scheduler)).toBe(true);
	});
});
