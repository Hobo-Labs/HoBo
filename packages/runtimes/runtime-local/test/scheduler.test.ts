import {
	CronExpressionUnsupportedError,
	type FiredTimer,
	parseScheduleId,
	SCHEDULER_PORT,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import { createCapabilityLinkTable } from "../src/capability/link-table.js";
import { createRuntimeLocalQueueClock } from "../src/replay.js";
import { createLocalScheduler } from "../src/scheduler.js";

function schedulerFixture() {
	const runtime = createRuntimeLocalQueueClock({
		seed: "scheduler-seed",
		startInstant: "2026-06-26T00:00:00.000Z",
	});
	return { runtime, scheduler: createLocalScheduler(runtime.clock) };
}

describe("runtime-local hobo:scheduler port", () => {
	it("serves and fires an interval job through the clock cron", () => {
		const { scheduler } = schedulerFixture();
		const fires: FiredTimer[] = [];

		const schedule = scheduler.registerJob(
			parseScheduleId("nightly"),
			{ everyMs: 1_000 },
			(fire) => fires.push(fire),
		);
		expect(schedule.deduped).toBe(false);

		const fired = scheduler.advance(3_000);

		expect(fired.map((fire) => fire.fireId)).toEqual([
			"cron:nightly:1",
			"cron:nightly:2",
			"cron:nightly:3",
		]);
		expect(fires.map((fire) => [fire.scheduleId, fire.occurrence])).toEqual([
			["nightly", 1],
			["nightly", 2],
			["nightly", 3],
		]);
	});

	it("every() is idempotent per schedule id (dedupes like clock cron)", () => {
		const { scheduler } = schedulerFixture();
		const first = scheduler.every(parseScheduleId("sync"), { everyMs: 500 });
		const second = scheduler.every(parseScheduleId("sync"), { everyMs: 500 });

		expect(first.deduped).toBe(false);
		expect(second.deduped).toBe(true);
		expect(second.scheduleId).toBe(first.scheduleId);
	});

	it("a scheduled bindle resource registers an interval job via the link table", async () => {
		const { runtime, scheduler } = schedulerFixture();
		const table = createCapabilityLinkTable({
			grants: [
				{
					componentId: "worker",
					importInterface: SCHEDULER_PORT,
					resource: "schedule:nightly",
					operations: ["every", "cron"],
				},
			],
		});
		table.registerComponent({ id: "worker", imports: [SCHEDULER_PORT] });
		table.registerProvider({
			id: "local-scheduler",
			exports: scheduler.providerExports(),
		});
		table.link({
			componentId: "worker",
			importInterface: SCHEDULER_PORT,
			providerId: "local-scheduler",
			exportInterface: SCHEDULER_PORT,
		});
		const handle = table.issueHandle({
			componentId: "worker",
			importInterface: SCHEDULER_PORT,
		});

		// SAFETY: assertion to `(await table.callWithHandle(handle, "every", { scheduleId: "nightly", everyMs: 1_000, })) as { scheduleId: string; dedup` is required at this boundary.
		const registered = (await table.callWithHandle(handle, "every", {
			scheduleId: "nightly",
			everyMs: 1_000,
		})) as { scheduleId: string; deduped: boolean };
		expect(registered.scheduleId).toBe("nightly");
		expect(registered.deduped).toBe(false);

		// The job is live in the local runtime host: virtual time fires it.
		const fired = runtime.clock.advance(2_000);
		expect(fired.map((fire) => fire.fireId)).toEqual([
			"cron:nightly:1",
			"cron:nightly:2",
		]);

		// v1 is interval-only: the WIT cron-expression form fails closed.
		await expect(
			table.callWithHandle(handle, "cron", { expr: "*/5 * * * *" }),
		).rejects.toThrow(CronExpressionUnsupportedError);
	});
});
