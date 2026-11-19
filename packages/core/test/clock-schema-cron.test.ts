import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import {
	ClockTraceEntrySchema,
	CronScheduleSchema,
} from "../src/_generated/clock_port_pb.js";

it("round-trips expression schedule and trace records", () => {
	const schedule = create(CronScheduleSchema, {
		scheduleId: "nightly",
		startAtMs: 1_000n,
		nextFireAtMs: 3_000n,
		expression: "0 3 * * *",
		timezone: "UTC",
	});
	const trace = create(ClockTraceEntrySchema, {
		type: "cron.expression-scheduled",
		scheduleId: "nightly",
		startAtMs: 1_000n,
		expression: "0 3 * * *",
		timezone: "UTC",
	});
	expect(
		fromBinary(CronScheduleSchema, toBinary(CronScheduleSchema, schedule)),
	).toMatchObject({
		scheduleId: "nightly",
		expression: "0 3 * * *",
		timezone: "UTC",
		nextFireAtMs: 3_000n,
	});
	expect(
		fromBinary(ClockTraceEntrySchema, toBinary(ClockTraceEntrySchema, trace)),
	).toMatchObject({
		type: "cron.expression-scheduled",
		scheduleId: "nightly",
		startAtMs: 1_000n,
		expression: "0 3 * * *",
		timezone: "UTC",
	});
});

it("round-trips interval jitter in schedule and trace records", () => {
	const schedule = create(CronScheduleSchema, {
		scheduleId: "reports",
		everyMs: 1_000n,
		startAtMs: 2_000n,
		nextFireAtMs: 2_050n,
		jitterMs: 100n,
	});
	const trace = create(ClockTraceEntrySchema, {
		type: "cron.scheduled",
		scheduleId: "reports",
		everyMs: 1_000n,
		startAtMs: 2_000n,
		jitterMs: 100n,
	});
	expect(
		fromBinary(CronScheduleSchema, toBinary(CronScheduleSchema, schedule)),
	).toMatchObject({ everyMs: 1_000n, jitterMs: 100n });
	expect(
		fromBinary(ClockTraceEntrySchema, toBinary(ClockTraceEntrySchema, trace)),
	).toMatchObject({ everyMs: 1_000n, jitterMs: 100n });
});

it("validates interval jitter in the clock trace schema", () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-clock-schema-"));
	try {
		const schema = fileURLToPath(
			new URL("../data-models/clock_port.cue", import.meta.url),
		);
		const input = join(directory, "trace.json");
		for (const [jitterMs, expected] of [
			[100, 0],
			[1_000, 1],
		] as const) {
			writeFileSync(
				input,
				JSON.stringify({
					type: "cron.scheduled",
					schedule_id: "reports",
					every_ms: 1_000,
					start_at_ms: 2_000,
					jitter_ms: jitterMs,
				}),
			);
			const result = spawnSync("cue", [
				"vet",
				schema,
				input,
				"-d",
				"#ClockTraceEntry",
			]);
			expect(result.status === 0 ? 0 : 1).toBe(expected);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
