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
		readonly every: (payload: JsonValue) => {
			readonly scheduleId: ScheduleId;
			readonly spec: {
				readonly tag: "every";
				readonly val: {
					readonly everyMs: number;
					readonly startAtMs?: number;
					readonly jitterMs?: number;
				};
			};
		};
		readonly cron: (payload: JsonValue) => {
			readonly scheduleId: ScheduleId;
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

	function nextProviderScheduleId(): ScheduleId {
		const registered = new Set(
			clock
				.trace()
				.flatMap((entry) =>
					entry.type === "cron.scheduled" ||
					entry.type === "cron.expression-scheduled"
						? [entry.scheduleId]
						: [],
				),
		);
		let sequence = 1;
		while (registered.has(`scheduler:${sequence}`)) sequence += 1;
		return parseScheduleId(`scheduler:${sequence}`);
	}

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
					every: (payload: JsonValue) => {
						const record = isJsonObject(payload) ? payload : {};
						if (
							Object.keys(record).some(
								(key) => !["everyMs", "startAtMs", "jitterMs"].includes(key),
							)
						) {
							throw new TypeError("invalid interval schedule fields");
						}
						const everyMs = record.everyMs;
						const startAtMs = record.startAtMs;
						const jitterMs = record.jitterMs;
						if (!isJsonNumber(everyMs)) {
							throw new TypeError("everyMs must be a number");
						}
						if (startAtMs !== undefined && !isJsonNumber(startAtMs)) {
							throw new TypeError("startAtMs must be a number");
						}
						if (jitterMs !== undefined && !isJsonNumber(jitterMs)) {
							throw new TypeError("jitterMs must be a number");
						}
						const spec = parseIntervalCronSpec({
							everyMs,
							...(isJsonNumber(startAtMs) ? { startAtMs } : undefined),
							...(isJsonNumber(jitterMs) ? { jitterMs } : undefined),
						});
						const schedule = scheduler.every(nextProviderScheduleId(), spec);
						return Object.freeze({
							scheduleId: schedule.scheduleId,
							spec: Object.freeze({ tag: "every" as const, val: spec }),
						});
					},
					cron: (payload: JsonValue) => {
						if (!isJsonString(payload) || payload.trim().length === 0) {
							throw new TypeError("expr must be a non-empty string");
						}
						const schedule = scheduler.cron(nextProviderScheduleId(), {
							expression: payload,
							timezone: "UTC",
						});
						return Object.freeze({
							scheduleId: schedule.scheduleId,
							spec: Object.freeze({
								tag: "cron" as const,
								val: Object.freeze({ expr: payload, timezone: "UTC" }),
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
