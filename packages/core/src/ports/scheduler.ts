import { CoreParseError } from "../errors.js";
import type { JsonValue } from "../json.js";
import {
	deepFreeze,
	nonNegativeInteger,
	positiveInteger,
} from "../parse-utils.js";
import { createPortDescriptor, type PortDescriptor } from "../ports.js";
import type { CronSchedule, IntervalCronSpec, ScheduleId } from "./clock.js";

// public-contract: the manifest/catalog port token schedule resources bind to (bindles CATALOG portRef, D14).
export const SCHEDULER_PORT = "hobo:scheduler";

// public-contract: WIT interface id of the scheduler port in the sdk world (packages/wit).
export const SCHEDULER_PORT_INTERFACE = "hobo:scheduler/scheduler@0.1.0";

export const SCHEDULER_PORT_DESCRIPTOR: PortDescriptor = createPortDescriptor({
	kind: "port",
	name: "scheduler",
	interface: SCHEDULER_PORT_INTERFACE,
	stability: "preview",
});

export interface SchedulerPort {
	every(scheduleId: ScheduleId, spec: IntervalCronSpec): CronSchedule;
}

export class SchedulerParseError extends CoreParseError {
	constructor(
		path: string,
		expected: string,
		received: JsonValue | undefined,
		message?: string,
	) {
		super("HOBO_CORE_SCHEDULER_PARSE", path, expected, received, message);
		this.name = "SchedulerParseError";
	}
}

export class CronExpressionUnsupportedError extends Error {
	readonly code = "SCHEDULER_CRON_UNSUPPORTED" as const;

	constructor(expr: string) {
		super(
			`hobo:scheduler v1 is interval-only (IntervalCronSpec); cron expression ${JSON.stringify(
				expr,
			)} is unsupported — no cron-expression parser exists (D14 recorded decision)`,
		);
		this.name = "CronExpressionUnsupportedError";
	}
}

export function parseIntervalCronSpec(record: {
	every_ms: number;
	start_at_ms?: number;
}): IntervalCronSpec {
	return deepFreeze({
		everyMs: positiveInteger(record.every_ms, "everyMs", SchedulerParseError),
		...(record.start_at_ms !== undefined
			? {
					startAtMs: nonNegativeInteger(
						record.start_at_ms,
						"startAtMs",
						SchedulerParseError,
					),
				}
			: undefined),
	});
}
