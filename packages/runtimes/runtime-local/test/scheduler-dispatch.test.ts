import { parseScheduleId } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { createRuntimeLocalQueueClock } from "../src/replay.js";
import { createLocalScheduler } from "../src/scheduler.js";

describe("local scheduler dispatch", () => {
	it("rejects conflicting intervals without changing the existing schedule", () => {
		const runtime = createRuntimeLocalQueueClock({
			startInstant: "2030-01-01T00:00:00.000Z",
		});
		const scheduler = createLocalScheduler(runtime.clock);
		const id = parseScheduleId("heartbeat");
		const initial = scheduler.every(id, { everyMs: 1_000 });
		const before = runtime.snapshot();
		expect(() => scheduler.every(id, { everyMs: 2_000 })).toThrow(
			/another recurrence/,
		);
		expect(() =>
			scheduler.every(id, {
				everyMs: 1_000,
				startAtMs: Date.parse(initial.nextFireAt) + 1_000,
			}),
		).toThrow(/another recurrence/);
		expect(() => scheduler.every(id, { everyMs: 0 })).toThrow();
		expect(runtime.snapshot()).toEqual(before);
		expect(
			scheduler.every(id, {
				everyMs: 1_000,
				startAtMs: Date.parse(initial.nextFireAt),
			}).deduped,
		).toBe(true);
		scheduler.advance(500);
		expect(scheduler.every(id, { everyMs: 1_000 }).deduped).toBe(true);
	});

	it("dispatches every due occurrence and reports all handler failures", () => {
		const runtime = createRuntimeLocalQueueClock({
			startInstant: "2030-01-01T00:00:00.000Z",
		});
		const scheduler = createLocalScheduler(runtime.clock);
		const observed: string[] = [];
		const failure = new Error("job failed");
		scheduler.registerJob(parseScheduleId("a"), { everyMs: 1_000 }, (fire) => {
			observed.push(fire.fireId);
			if (fire.occurrence !== 3) throw failure;
		});
		scheduler.registerJob(parseScheduleId("b"), { everyMs: 1_000 }, (fire) => {
			observed.push(fire.fireId);
		});

		let thrown: unknown;
		try {
			scheduler.advance(2_000);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(AggregateError);
		if (!(thrown instanceof AggregateError))
			throw new Error("expected failure");
		expect(thrown.errors).toHaveLength(2);
		expect(thrown.errors.map((error: Error) => error.message)).toEqual([
			"Scheduled job cron:a:1 failed",
			"Scheduled job cron:a:2 failed",
		]);
		expect(thrown.errors.map((error: Error) => error.cause)).toEqual([
			failure,
			failure,
		]);
		expect(observed).toEqual(["cron:a:1", "cron:b:1", "cron:a:2", "cron:b:2"]);
		expect(scheduler.advance(1_000).map((fire) => fire.fireId)).toEqual([
			"cron:a:3",
			"cron:b:3",
		]);
	});

	it("awaits asynchronous jobs in fire order and reports failures after dispatch", async () => {
		const runtime = createRuntimeLocalQueueClock({
			startInstant: "2030-01-01T00:00:00.000Z",
		});
		const scheduler = createLocalScheduler(runtime.clock);
		const observed: string[] = [];
		const failure = new Error("asynchronous failure");
		scheduler.registerJob(
			parseScheduleId("a"),
			{ everyMs: 1_000 },
			async (fire) => {
				observed.push(`start:${fire.fireId}`);
				await Promise.resolve();
				observed.push(`end:${fire.fireId}`);
				if (fire.occurrence === 1) throw failure;
			},
		);
		scheduler.registerJob(parseScheduleId("b"), { everyMs: 1_000 }, (fire) => {
			observed.push(fire.fireId);
		});

		let thrown: unknown;
		try {
			await scheduler.advanceAsync(2_000);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(AggregateError);
		if (!(thrown instanceof AggregateError))
			throw new Error("expected failure");
		expect(thrown.errors).toHaveLength(1);
		expect(thrown.errors[0]).toMatchObject({
			message: "Scheduled job cron:a:1 failed",
			cause: failure,
		});
		expect(observed).toEqual([
			"start:cron:a:1",
			"end:cron:a:1",
			"cron:b:1",
			"start:cron:a:2",
			"end:cron:a:2",
			"cron:b:2",
		]);
		expect(
			(await scheduler.advanceAsync(1_000)).map((fire) => fire.fireId),
		).toEqual(["cron:a:3", "cron:b:3"]);
	});

	it("rejects overlapping advances until the asynchronous job settles", async () => {
		const runtime = createRuntimeLocalQueueClock({
			startInstant: "2030-01-01T00:00:00.000Z",
		});
		const scheduler = createLocalScheduler(runtime.clock);
		let release = () => {};
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		scheduler.registerJob(
			parseScheduleId("a"),
			{ everyMs: 1_000 },
			() => blocked,
		);
		const advancing = scheduler.advanceAsync(1_000);
		expect(() => scheduler.advance(1_000)).toThrow(/already advancing/);
		await expect(scheduler.advanceAsync(1_000)).rejects.toThrow(
			/already advancing/,
		);
		release();
		await expect(advancing).resolves.toHaveLength(1);
		expect(runtime.clock.now()).toBe("2030-01-01T00:00:01.000Z");
	});

	it("reports a promise returned to synchronous advance", async () => {
		const runtime = createRuntimeLocalQueueClock({
			startInstant: "2030-01-01T00:00:00.000Z",
		});
		const scheduler = createLocalScheduler(runtime.clock);
		scheduler.registerJob(
			parseScheduleId("a"),
			{ everyMs: 1_000 },
			async () => {
				throw new Error("rejected job");
			},
		);
		let thrown: unknown;
		try {
			scheduler.advance(1_000);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(AggregateError);
		if (!(thrown instanceof AggregateError))
			throw new Error("expected failure");
		expect(thrown.errors[0]?.cause).toEqual(
			new TypeError("asynchronous scheduled jobs require advanceAsync"),
		);
		await Promise.resolve();
	});
});
