import {
	type CronSchedule,
	type FiredTimer,
	type IntervalCronSpec,
	parseCronEveryMs,
	parseDelayMs,
	parseFireId,
	parseIsoInstant,
	parseRunId,
	parseScheduleId,
	parseTimerId,
	type RunId,
	type ScheduledTimer,
	type ScheduleId,
	type TimerOptions,
	type VirtualClock,
} from "@hobo/core";

import {
	appendTrace,
	type CronScheduleRecord,
	formatInstant,
	normalizeNonNegativeInteger,
	type QueueClockStore,
	requireNonEmptyString,
	type SleepTimerRecord,
} from "./queue-clock-store.js";

export function createLocalClock(store: QueueClockStore): VirtualClock {
	return Object.freeze({
		now() {
			return parseIsoInstant(formatInstant(store.nowMs));
		},

		nowMs() {
			return store.nowMs;
		},

		sleep(
			runId: RunId,
			delayMs: number,
			options: TimerOptions,
		): ScheduledTimer {
			const idempotencyKey = requireNonEmptyString(
				options.idempotencyKey,
				"options.idempotencyKey",
			);
			const previous = store.timers.find(
				(timer) => timer.idempotencyKey === idempotencyKey,
			);
			if (previous) {
				return publicSleepTimer(previous, true);
			}

			const delay = parseDelayMs(delayMs);
			const timer: SleepTimerRecord = {
				timerId: `timer-${store.nextTimerSeq++}`,
				kind: "sleep",
				runId,
				idempotencyKey,
				scheduledAtMs: store.nowMs,
				fireAtMs: store.nowMs + delay,
				firedAtMs: null,
				firedOrder: null,
				...(options.label !== undefined ? { label: options.label } : undefined),
			};
			store.timers.push(timer);
			appendTrace(store, {
				type: "timer.scheduled",
				timerId: timer.timerId,
				runId: timer.runId,
				idempotencyKey: timer.idempotencyKey,
				delayMs: delay,
				scheduledAtMs: timer.scheduledAtMs,
				fireAtMs: timer.fireAtMs,
				...(timer.label !== undefined ? { label: timer.label } : undefined),
			});

			return publicSleepTimer(timer, false);
		},

		cron(scheduleId: ScheduleId, spec: IntervalCronSpec): CronSchedule {
			const id = scheduleId;
			const previous = store.cronSchedules.find(
				(schedule) => schedule.scheduleId === id,
			);
			if (previous) {
				return publicCronSchedule(previous, true);
			}

			const everyMs = parseCronEveryMs(spec.everyMs);
			const startAtMs = normalizeNonNegativeInteger(
				spec.startAtMs ?? store.nowMs + everyMs,
				"spec.startAtMs",
			);
			const schedule: CronScheduleRecord = {
				scheduleId: id,
				everyMs,
				startAtMs,
				nextFireAtMs: startAtMs,
				occurrence: 0,
			};
			store.cronSchedules.push(schedule);
			appendTrace(store, {
				type: "cron.scheduled",
				scheduleId: id,
				everyMs,
				startAtMs,
			});

			return publicCronSchedule(schedule, false);
		},

		advance(deltaMs: number): readonly FiredTimer[] {
			const delta = parseDelayMs(deltaMs);
			const fromMs = store.nowMs;
			store.nowMs += delta;
			appendTrace(store, {
				type: "clock.advanced",
				deltaMs: delta,
				fromMs,
				toMs: store.nowMs,
			});

			const fired: FiredTimer[] = [];
			for (;;) {
				const due = nextDueFire(store);
				if (!due) {
					break;
				}
				fired.push(fireDue(store, due));
			}
			return Object.freeze(fired);
		},

		trace() {
			return Object.freeze([...store.trace]);
		},
	});
}

type DueFire =
	| { kind: "sleep"; key: string; fireAtMs: number; timer: SleepTimerRecord }
	| {
			kind: "cron";
			key: string;
			fireAtMs: number;
			schedule: CronScheduleRecord;
	  };

function nextDueFire(store: QueueClockStore): DueFire | undefined {
	const candidates: DueFire[] = [];
	for (const timer of store.timers) {
		if (timer.firedAtMs === null && timer.fireAtMs <= store.nowMs) {
			candidates.push({
				kind: "sleep",
				key: timer.timerId,
				fireAtMs: timer.fireAtMs,
				timer,
			});
		}
	}
	for (const schedule of store.cronSchedules) {
		if (schedule.nextFireAtMs <= store.nowMs) {
			candidates.push({
				kind: "cron",
				key: schedule.scheduleId,
				fireAtMs: schedule.nextFireAtMs,
				schedule,
			});
		}
	}

	candidates.sort(
		(left, right) =>
			left.fireAtMs - right.fireAtMs ||
			left.kind.localeCompare(right.kind) ||
			left.key.localeCompare(right.key),
	);
	return candidates[0];
}

function fireDue(store: QueueClockStore, due: DueFire): FiredTimer {
	const order = store.nextFireSeq++;
	if (due.kind === "sleep") {
		due.timer.firedAtMs = due.fireAtMs;
		due.timer.firedOrder = order;
		const fired = Object.freeze({
			fireId: parseFireId(`timer:${due.timer.timerId}`),
			kind: "sleep" as const,
			timerId: parseTimerId(due.timer.timerId),
			runId: parseRunId(due.timer.runId),
			at: parseIsoInstant(formatInstant(due.fireAtMs)),
			order,
			...(due.timer.label !== undefined
				? { label: due.timer.label }
				: undefined),
		});
		appendTrace(store, {
			type: "timer.fired",
			fireId: fired.fireId,
			timerId: fired.timerId,
			runId: fired.runId,
			atMs: due.fireAtMs,
			order,
		});
		return fired;
	}

	due.schedule.occurrence += 1;
	const occurrence = due.schedule.occurrence;
	const fireAtMs = due.schedule.nextFireAtMs;
	due.schedule.nextFireAtMs += due.schedule.everyMs;
	const fired = Object.freeze({
		fireId: parseFireId(`cron:${due.schedule.scheduleId}:${occurrence}`),
		kind: "cron" as const,
		scheduleId: parseScheduleId(due.schedule.scheduleId),
		occurrence,
		at: parseIsoInstant(formatInstant(fireAtMs)),
		order,
	});
	appendTrace(store, {
		type: "cron.fired",
		fireId: fired.fireId,
		scheduleId: fired.scheduleId,
		occurrence,
		atMs: fireAtMs,
		order,
	});
	return fired;
}

function publicSleepTimer(
	timer: SleepTimerRecord,
	deduped: boolean,
): ScheduledTimer {
	return Object.freeze({
		timerId: parseTimerId(timer.timerId),
		runId: parseRunId(timer.runId),
		idempotencyKey: timer.idempotencyKey,
		fireAt: parseIsoInstant(formatInstant(timer.fireAtMs)),
		deduped,
	});
}

function publicCronSchedule(
	schedule: CronScheduleRecord,
	deduped: boolean,
): CronSchedule {
	return Object.freeze({
		scheduleId: parseScheduleId(schedule.scheduleId),
		everyMs: schedule.everyMs,
		nextFireAt: parseIsoInstant(formatInstant(schedule.nextFireAtMs)),
		deduped,
	});
}
