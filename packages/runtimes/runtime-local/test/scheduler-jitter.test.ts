import { parseScheduleId, SCHEDULER_PORT } from "@hobo/core";
import { expect, it } from "vitest";
import {
	createRuntimeLocalQueueClock,
	replayClockTrace,
} from "../src/replay.js";
import { createLocalScheduler } from "../src/scheduler.js";

const startInstant = "2030-01-01T00:00:00.000Z";
const startMs = Date.parse(startInstant);
const scheduleId = parseScheduleId("reports");

function fixture(seed = "jitter-seed") {
	const runtime = createRuntimeLocalQueueClock({ seed, startInstant });
	const scheduler = createLocalScheduler(runtime.clock);
	return { runtime, scheduler };
}

it("fires each occurrence within its deterministic jitter window", () => {
	const { scheduler, runtime } = fixture();
	scheduler.every(scheduleId, { everyMs: 1_000, jitterMs: 300 });
	const fired = scheduler.advance(8_500);
	expect(fired).toHaveLength(8);
	const offsets = fired.map((fire, index) => {
		const offset = Date.parse(fire.at) - (startMs + (index + 1) * 1_000);
		expect(offset).toBeGreaterThanOrEqual(0);
		expect(offset).toBeLessThanOrEqual(300);
		return offset;
	});
	expect(new Set(offsets).size).toBeGreaterThan(1);
	const other = fixture("another-seed");
	other.scheduler.every(scheduleId, { everyMs: 1_000, jitterMs: 300 });
	expect(other.scheduler.advance(8_500).map((fire) => fire.at)).not.toEqual(
		fired.map((fire) => fire.at),
	);
	expect(replayClockTrace(runtime.clock.trace()).fireOrder).toEqual(
		fired.map((fire) => fire.fireId),
	);
});

it("continues the same sequence after restoring a snapshot", () => {
	const { scheduler, runtime } = fixture();
	scheduler.every(scheduleId, { everyMs: 1_000, jitterMs: 300 });
	scheduler.advance(3_500);
	const snapshot = runtime.snapshot();
	const restored = createRuntimeLocalQueueClock({ snapshot });
	const afterRestart = restored.clock.advance(5_000);
	const uninterrupted = scheduler.advance(5_000);
	expect(afterRestart).toEqual(uninterrupted);
	expect(replayClockTrace(restored.clock.trace()).fireOrder).toEqual(
		runtime.clock
			.trace()
			.flatMap((entry) => (entry.type === "cron.fired" ? [entry.fireId] : [])),
	);
	const incomplete = structuredClone(snapshot);
	Object.assign(incomplete.cronSchedules[0] ?? {}, { jitterMs: undefined });
	expect(() => createRuntimeLocalQueueClock({ snapshot: incomplete })).toThrow(
		/schedule.jitterMs/,
	);
});

it("rejects conflicting or invalid jitter before changing a schedule", () => {
	const { scheduler, runtime } = fixture();
	scheduler.every(scheduleId, { everyMs: 1_000, jitterMs: 50 });
	const before = runtime.snapshot();
	expect(() =>
		scheduler.every(scheduleId, { everyMs: 1_000, jitterMs: 51 }),
	).toThrow(/another recurrence/);
	for (const jitterMs of [-1, 1_000, 1.5]) {
		expect(() =>
			scheduler.every(parseScheduleId("invalid"), { everyMs: 1_000, jitterMs }),
		).toThrow();
	}
	expect(() =>
		scheduler.every(parseScheduleId("out-of-range"), {
			everyMs: 1_000,
			startAtMs: 8_640_000_000_000_001,
		}),
	).toThrow(/clock range/);
	expect(runtime.snapshot()).toEqual(before);
});

it("accepts jitter through the local scheduler provider", () => {
	const { scheduler, runtime } = fixture();
	const port = scheduler.providerExports()[SCHEDULER_PORT];
	if (!port) throw new Error("scheduler port missing");
	const reference = port.every({ everyMs: 1_000, jitterMs: 200 });
	expect(reference.spec).toEqual({
		tag: "every",
		val: { everyMs: 1_000, jitterMs: 200 },
	});
	const fired = scheduler.advance(1_200);
	expect(fired).toHaveLength(1);
	expect(Date.parse(fired[0]?.at ?? "") - startMs).toBeGreaterThanOrEqual(
		1_000,
	);
	expect(runtime.snapshot().cronSchedules[0]).toMatchObject({ jitterMs: 200 });
});
