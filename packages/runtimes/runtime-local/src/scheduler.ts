import {
	type CronExpressionSchedule,
	type CronExpressionSpec,
	type CronSchedule,
	type FiredTimer,
	type IntervalCronSpec,
	parseIntervalCronSpec,
	parseScheduleId,
	SCHEDULER_PORT,
	type ScheduleId,
	type SchedulerPort,
	type VirtualClock,
} from "@hobo/core";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "./json.js";

export type ScheduledJobHandler =
	| ((fire: FiredTimer) => void)
	| ((fire: FiredTimer) => PromiseLike<void>);

export interface LocalScheduler extends SchedulerPort {
	registerJob(
		scheduleId: ScheduleId,
		spec: IntervalCronSpec,
		onFire: ScheduledJobHandler,
	): CronSchedule;
	registerCronJob(
		scheduleId: ScheduleId,
		spec: CronExpressionSpec,
		onFire: ScheduledJobHandler,
	): CronExpressionSchedule;
	advance(deltaMs: number): readonly FiredTimer[];
	advanceAsync(deltaMs: number): Promise<readonly FiredTimer[]>;
	providerExports(): SchedulerProviderExports;
}

export interface SchedulerProviderExports {
	readonly [port: string]: {
		readonly every: (payload: JsonValue) => CronSchedule;
		readonly cron: (payload: JsonValue) => CronExpressionSchedule & {
			readonly spec: {
				readonly tag: "cron";
				readonly val: { readonly expr: string; readonly timezone: string };
			};
		};
	};
}

export function createLocalScheduler(clock: VirtualClock): LocalScheduler {
	const jobs = new Map<string, ScheduledJobHandler>();
	let advancing = false;

	function beginAdvance(): void {
		if (advancing) throw new Error("scheduler is already advancing");
		advancing = true;
	}

	function jobFor(fire: FiredTimer): ScheduledJobHandler | undefined {
		return fire.kind === "cron" && fire.scheduleId !== undefined
			? jobs.get(fire.scheduleId)
			: undefined;
	}

	function jobFailure(fire: FiredTimer, cause: unknown): Error {
		return new Error(`Scheduled job ${fire.fireId} failed`, { cause });
	}

	const scheduler: LocalScheduler = {
		every(scheduleId: ScheduleId, spec: IntervalCronSpec): CronSchedule {
			return clock.cron(scheduleId, spec);
		},
		cron(
			scheduleId: ScheduleId,
			spec: CronExpressionSpec,
		): CronExpressionSchedule {
			return clock.cronExpression(scheduleId, spec);
		},

		registerJob(
			scheduleId: ScheduleId,
			spec: IntervalCronSpec,
			onFire: ScheduledJobHandler,
		): CronSchedule {
			const schedule = clock.cron(scheduleId, spec);
			jobs.set(schedule.scheduleId, onFire);
			return schedule;
		},
		registerCronJob(scheduleId, spec, onFire) {
			const schedule = clock.cronExpression(scheduleId, spec);
			jobs.set(schedule.scheduleId, onFire);
			return schedule;
		},

		advance(deltaMs: number): readonly FiredTimer[] {
			beginAdvance();
			try {
				const fired = clock.advance(deltaMs);
				const failures: Error[] = [];
				for (const fire of fired) {
					try {
						const result = jobFor(fire)?.(fire);
						if (isPromiseLike(result)) {
							void Promise.resolve(result).catch(() => {});
							throw new TypeError(
								"asynchronous scheduled jobs require advanceAsync",
							);
						}
					} catch (error) {
						failures.push(jobFailure(fire, error));
					}
				}
				if (failures.length > 0)
					throw new AggregateError(failures, "Scheduled jobs failed");
				return fired;
			} finally {
				advancing = false;
			}
		},

		async advanceAsync(deltaMs: number): Promise<readonly FiredTimer[]> {
			beginAdvance();
			try {
				const fired = clock.advance(deltaMs);
				const failures: Error[] = [];
				for (const fire of fired) {
					try {
						await jobFor(fire)?.(fire);
					} catch (error) {
						failures.push(jobFailure(fire, error));
					}
				}
				if (failures.length > 0)
					throw new AggregateError(failures, "Scheduled jobs failed");
				return fired;
			} finally {
				advancing = false;
			}
		},

		providerExports() {
			return {
				[SCHEDULER_PORT]: {
					every: (payload: JsonValue): CronSchedule => {
						const record = isJsonObject(payload) ? payload : {};
						const everyMs = record.everyMs ?? record.every_ms;
						const startAtMs =
							record.startAtMs !== undefined
								? record.startAtMs
								: record.start_at_ms;
						if (!isJsonNumber(everyMs)) {
							throw new TypeError("everyMs must be a number");
						}
						if (startAtMs !== undefined && !isJsonNumber(startAtMs)) {
							throw new TypeError("startAtMs must be a number");
						}
						const spec = parseIntervalCronSpec({
							every_ms: everyMs,
							...(isJsonNumber(startAtMs)
								? { start_at_ms: startAtMs }
								: undefined),
						});
						return scheduler.every(
							parseScheduleId(String(record.scheduleId ?? "")),
							spec,
						);
					},
					cron: (payload: JsonValue) => {
						const record = isJsonObject(payload) ? payload : {};
						const expression = isJsonString(payload) ? payload : record.expr;
						if (!isJsonString(expression) || expression.trim().length === 0) {
							throw new TypeError("expr must be a non-empty string");
						}
						const timezone = record.timezone ?? "UTC";
						if (!isJsonString(timezone) || timezone.length === 0) {
							throw new TypeError("timezone must be a non-empty string");
						}
						const generatedId = `cron-expression:${encodeURIComponent(timezone)}:${encodeURIComponent(expression)}`;
						const id = record.scheduleId ?? record.schedule_id ?? generatedId;
						if (!isJsonString(id))
							throw new TypeError("scheduleId must be a string");
						const schedule = scheduler.cron(parseScheduleId(id), {
							expression,
							timezone,
						});
						return Object.freeze({
							...schedule,
							spec: Object.freeze({
								tag: "cron" as const,
								val: Object.freeze({ expr: expression, timezone }),
							}),
						});
					},
				},
			};
		},
	};

	return Object.freeze(scheduler);
}

function isPromiseLike(
	value: void | PromiseLike<void>,
): value is PromiseLike<void> {
	return (
		value !== undefined &&
		value !== null &&
		Object(value) === value &&
		value.then instanceof Function
	);
}
