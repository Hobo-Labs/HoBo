import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

	it("allocates distinct references across schedules and restarts", () => {
		const { port, runtime, scheduler } = fixture();
		if (!port) throw new Error("scheduler port missing");
		scheduler.every(parseScheduleId("scheduler:1"), { everyMs: 500 });
		const first = port.every({ everyMs: 1_000 });
		const second = port.cron("*/5 * * * *");
		expect([first.scheduleId, second.scheduleId]).toEqual([
			"scheduler:2",
			"scheduler:3",
		]);
		const restored = createRuntimeLocalQueueClock({
			snapshot: runtime.snapshot(),
		});
		const restoredPort = createLocalScheduler(restored.clock).providerExports()[
			SCHEDULER_PORT
		];
		expect(restoredPort?.every({ everyMs: 1_000 }).scheduleId).toBe(
			"scheduler:4",
		);
	});

	it("emits interval and cron references accepted by their schema", () => {
		const { port } = fixture();
		if (!port) throw new Error("scheduler port missing");
		const directory = mkdtempSync(join(tmpdir(), "hobo-schedule-reference-"));
		try {
			const schema = fileURLToPath(
				new URL("../../../core/data-models/clock_port.cue", import.meta.url),
			);
			const input = join(directory, "reference.json");
			for (const reference of [
				port.every({ everyMs: 1_000, jitterMs: 200 }),
				port.cron("*/5 * * * *"),
			]) {
				writeFileSync(input, JSON.stringify(reference));
				const result = spawnSync(
					"cue",
					["vet", schema, input, "-d", "#SchedulerReference"],
					{
						encoding: "utf8",
					},
				);
				expect(result.status, result.stderr).toBe(0);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("offers both WIT operations", () => {
		expect(Object.keys(fixture().port ?? {}).sort()).toStrictEqual([
			"cron",
			"every",
		]);
	});
});

describe("registering an interval", () => {
	it("returns a reference containing the registered interval", () => {
		const { port } = fixture();
		expect(port?.every({ everyMs: 1_000 })).toEqual({
			scheduleId: "scheduler:1",
			spec: { tag: "every", val: { everyMs: 1_000 } },
		});
	});

	it("registers a job that actually fires on the clock", () => {
		const { port, scheduler } = fixture();
		const fires: FiredTimer[] = [];
		const reference = port?.every({ everyMs: 1_000 });
		if (!reference) throw new Error("scheduler port missing");
		scheduler.registerJob(reference.scheduleId, { everyMs: 1_000 }, (fire) =>
			fires.push(fire),
		);
		scheduler.advance(3_000);
		expect(fires.length).toBeGreaterThan(0);
	});

	it("accepts a start offset", () => {
		const { port } = fixture();
		expect(() => port?.every({ everyMs: 1_000, startAtMs: 500 })).not.toThrow();
	});

	it("rejects a start offset that is not a number", () => {
		const { port } = fixture();
		for (const startAtMs of ["soon", null, true]) {
			expect(() => port?.every({ everyMs: 1_000, startAtMs })).toThrow(
				/startAtMs must be a number/,
			);
		}
	});
});

describe("intervals the port refuses", () => {
	it("refuses a missing interval", () => {
		expect(() => fixture().port?.every({})).toThrow(/everyMs must be a number/);
	});

	it("refuses an interval sent as a string", () => {
		expect(() => fixture().port?.every({ everyMs: "1000" })).toThrow(TypeError);
	});

	it("refuses a null interval", () => {
		expect(() => fixture().port?.every({ everyMs: null })).toThrow(TypeError);
	});

	it("rejects unrecognized interval fields", () => {
		expect(() =>
			fixture().port?.every({ everyMs: 1_000, unexpected: 5 }),
		).toThrow("invalid interval schedule fields");
	});

	it("refuses a payload that is not an object", () => {
		for (const payload of [[], "nightly", 1_000, null]) {
			expect(() => fixture().port?.every(payload)).toThrow(TypeError);
		}
	});
});

describe("cron expressions", () => {
	it("registers the WIT expression", () => {
		expect(fixture().port?.cron("0 3 * * *")).toMatchObject({
			spec: { tag: "cron", val: { expr: "0 3 * * *", timezone: "UTC" } },
		});
	});

	it("rejects malformed expressions", () => {
		expect(() => fixture().port?.cron("not cron")).toThrow(TypeError);
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
