import { CoreParseError } from "../errors.js";
import type { JsonValue } from "../json.js";
import {
	deepFreeze,
	nonNegativeInteger,
	positiveInteger,
} from "../parse-utils.js";
import { createPortDescriptor, type PortDescriptor } from "../ports.js";
import type {
	CronExpressionSchedule,
	CronExpressionSpec,
	CronSchedule,
	IntervalCronSpec,
	ScheduleId,
} from "./clock.js";

export const SCHEDULER_PORT = "hobo:scheduler";

export const SCHEDULER_PORT_INTERFACE = "hobo:scheduler/scheduler@0.1.0";

export const SCHEDULER_PORT_DESCRIPTOR: PortDescriptor = createPortDescriptor({
	kind: "port",
	name: "scheduler",
	interface: SCHEDULER_PORT_INTERFACE,
	stability: "preview",
});

export interface SchedulerPort {
	every(scheduleId: ScheduleId, spec: IntervalCronSpec): CronSchedule;
	cron(
		scheduleId: ScheduleId,
		spec: CronExpressionSpec,
	): CronExpressionSchedule;
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
			`Cron expression ${JSON.stringify(expr)} is unsupported by this scheduler`,
		);
		this.name = "CronExpressionUnsupportedError";
	}
}

export function parseIntervalCronSpec(
	record: IntervalCronSpec,
): IntervalCronSpec {
	const unknownField = Object.keys(record).find(
		(field) => !["everyMs", "startAtMs", "jitterMs"].includes(field),
	);
	if (unknownField !== undefined) {
		throw new SchedulerParseError(
			unknownField,
			"known interval field",
			unknownField,
		);
	}
	const everyMs = positiveInteger(
		record.everyMs,
		"everyMs",
		SchedulerParseError,
	);
	const jitterMs =
		record.jitterMs === undefined
			? undefined
			: nonNegativeInteger(record.jitterMs, "jitterMs", SchedulerParseError);
	if (jitterMs !== undefined && jitterMs >= everyMs) {
		throw new SchedulerParseError(
			"jitterMs",
			`integer less than ${everyMs}`,
			jitterMs,
		);
	}
	return deepFreeze({
		everyMs,
		...(record.startAtMs !== undefined
			? {
					startAtMs: nonNegativeInteger(
						record.startAtMs,
						"startAtMs",
						SchedulerParseError,
					),
				}
			: undefined),
		...(jitterMs !== undefined ? { jitterMs } : undefined),
	});
}
