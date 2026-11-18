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
