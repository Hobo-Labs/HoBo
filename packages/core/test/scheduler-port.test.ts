import { describe, expect, it } from "vitest";

import {
	CronExpressionUnsupportedError,
	createPortDescriptor,
	parseIntervalCronSpec,
	SCHEDULER_PORT,
	SCHEDULER_PORT_DESCRIPTOR,
	SCHEDULER_PORT_INTERFACE,
	SchedulerParseError,
} from "../src/index.js";

describe("hobo:scheduler port descriptor", () => {
	it("pins the manifest port token and the WIT interface id", () => {
		expect(SCHEDULER_PORT).toBe("hobo:scheduler");
		expect(SCHEDULER_PORT_INTERFACE).toBe("hobo:scheduler/scheduler@0.1.0");
	});

	it("has the port-descriptor shape and round-trips createPortDescriptor", () => {
		expect(SCHEDULER_PORT_DESCRIPTOR).toEqual({
			kind: "port",
			name: "scheduler",
			interface: SCHEDULER_PORT_INTERFACE,
			stability: "preview",
		});
		expect(Object.isFrozen(SCHEDULER_PORT_DESCRIPTOR)).toBe(true);
		expect(createPortDescriptor({ ...SCHEDULER_PORT_DESCRIPTOR })).toEqual(
			SCHEDULER_PORT_DESCRIPTOR,
		);
	});

	it("parses interval specs (v1 is interval-only)", () => {
		expect(parseIntervalCronSpec({ every_ms: 1_000 })).toEqual({
			everyMs: 1_000,
		});
		expect(parseIntervalCronSpec({ every_ms: 500, start_at_ms: 0 })).toEqual({
			everyMs: 500,
			startAtMs: 0,
		});
	});

	it("rejects non-positive intervals and negative starts", () => {
		expect(() => parseIntervalCronSpec({ every_ms: 0 })).toThrow(
			SchedulerParseError,
		);
		expect(() =>
			parseIntervalCronSpec({ every_ms: 1_000, start_at_ms: -1 }),
		).toThrow(SchedulerParseError);
		try {
			parseIntervalCronSpec({ every_ms: -5 });
			expect.unreachable();
		} catch (error) {
			expect((error as SchedulerParseError).code).toBe(
				"HOBO_CORE_SCHEDULER_PARSE",
			);
		}
	});

	it("fails closed on the WIT cron-expression form", () => {
		const error = new CronExpressionUnsupportedError("*/5 * * * *");
		expect(error.code).toBe("SCHEDULER_CRON_UNSUPPORTED");
		expect(error.message).toMatch(/interval-only/);
		expect(error.message).toMatch(/\*\/5 \* \* \* \*/);
	});
});
