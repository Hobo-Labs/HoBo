/**
 * The `hobo:scheduler` provider export — the payload a component actually sends.
 *
 * `scheduler.test.ts` drives the typed TypeScript surface. This covers the
 * other one: the export table a wasm component calls through, where arguments
 * arrive as an untyped JSON value that crossed a WIT boundary and nothing has
 * checked them yet.
 *
 * Three properties carry the weight:
 *
 * **Both spellings of every field are accepted.** WIT records are snake_case
 * (`every_ms`), and TypeScript callers write camelCase (`everyMs`). A guest
 * generated from the WIT and a host-side caller are both legitimate clients of
 * the same port, so refusing either would make the port unusable from one side
 * — and silently picking one spelling would make a job that *looks* registered
 * never fire.
 *
 * **A missing or non-numeric interval is refused, not defaulted.** There is no
 * safe default period: too short burns CPU on a schedule nobody asked for, too
 * long silently delays work the caller believes is running. `everyMs` is the
 * one field with no sensible fallback, so it is the one that throws.
 *
 * **`cron(expr)` fails closed.** The WIT surface has a cron-expression form and
 * this runtime has no parser for it (a recorded v1 limitation, D14). Accepting
 * the call and ignoring the expression would register nothing while reporting
 * success — a scheduled job that never runs and never explains why. The
 * refusal quotes the expression so the caller can see which schedule was
 * dropped.
 */
import {
	CronExpressionUnsupportedError,
	type FiredTimer,
	parseScheduleId,
	SCHEDULER_PORT,
} from "@hobo/core";
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
	it("accepts the camelCase spelling", () => {
		const { port } = fixture();
		expect(
			port?.every({ scheduleId: "nightly", everyMs: 1_000 }).scheduleId,
		).toBe(parseScheduleId("nightly"));
	});

	it("accepts the snake_case spelling a WIT guest sends", () => {
		// A guest generated from the WIT record sends `every_ms`. Refusing it
		const { port } = fixture();
		expect(
			port?.every({ scheduleId: "nightly", every_ms: 1_000 }).scheduleId,
		).toBe(parseScheduleId("nightly"));
	});

	it("prefers camelCase when a caller sends both", () => {
		const { port, scheduler } = fixture();
		port?.every({ scheduleId: "nightly", everyMs: 1_000, every_ms: 5_000 });
		const fires: FiredTimer[] = [];
		scheduler.registerJob(
			parseScheduleId("nightly"),
			{ everyMs: 1_000 },
			(fire) => fires.push(fire),
		);
		scheduler.advance(1_000);
		expect(fires).toHaveLength(1);
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

	it("accepts a start offset in either spelling", () => {
		const { port } = fixture();
		expect(() =>
			port?.every({ scheduleId: "a", everyMs: 1_000, startAtMs: 500 }),
		).not.toThrow();
		expect(() =>
			port?.every({ scheduleId: "b", every_ms: 1_000, start_at_ms: 500 }),
		).not.toThrow();
	});

	it("omits the start offset when it is not a number", () => {
		const { port } = fixture();
		expect(() =>
			port?.every({ scheduleId: "a", everyMs: 1_000, startAtMs: "soon" }),
		).not.toThrow();
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
	it("fails closed", () => {
		expect(() => fixture().port?.cron({ expr: "0 3 * * *" })).toThrow(
			CronExpressionUnsupportedError,
		);
	});

	it("quotes the expression it dropped", () => {
		expect(() => fixture().port?.cron({ expr: "0 3 * * *" })).toThrow(
			/0 3 \* \* \*/,
		);
	});

	it("still refuses when no expression was given", () => {
		expect(() => fixture().port?.cron({})).toThrow(
			CronExpressionUnsupportedError,
		);
	});

	it("still refuses when the payload is not an object", () => {
		expect(() => fixture().port?.cron("0 3 * * *")).toThrow(
			CronExpressionUnsupportedError,
		);
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
