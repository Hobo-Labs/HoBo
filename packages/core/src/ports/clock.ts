import { CoreParseError } from "../errors.js";
import type { JsonValue } from "../json.js";
import {
	deepFreeze,
	isoTimestamp,
	nonEmptyString,
	nonNegativeInteger,
	positiveInteger,
} from "../parse-utils.js";
import { parseRunId, type RunId } from "./streamer.js";

export type IsoInstant = string & { readonly __brand: "IsoInstant" };
export type TimerId = string & { readonly __brand: "TimerId" };
export type ScheduleId = string & { readonly __brand: "ScheduleId" };
export type FireId = string & { readonly __brand: "FireId" };

export interface TimerOptions {
	readonly idempotencyKey: string;
	readonly label?: string;
}

export interface IntervalCronSpec {
	readonly everyMs: number;
	readonly startAtMs?: number;
}

export interface ScheduledTimer {
	readonly timerId: TimerId;
	readonly runId: RunId;
	readonly idempotencyKey: string;
	readonly fireAt: IsoInstant;
	readonly deduped: boolean;
}

// domain-view: parse-don't-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface CronSchedule {
	readonly scheduleId: ScheduleId;
	readonly everyMs: number;
	readonly nextFireAt: IsoInstant;
	readonly deduped: boolean;
}

export interface FiredTimer {
	readonly fireId: FireId;
	readonly kind: "sleep" | "cron";
	readonly timerId?: TimerId;
	readonly runId?: RunId;
	readonly label?: string;
	readonly scheduleId?: ScheduleId;
	readonly occurrence?: number;
	readonly at: IsoInstant;
	readonly order: number;
}

export type ClockTraceEntry =
	| {
			readonly type: "clock.started";
			readonly seed: string;
			readonly atMs: number;
			readonly at: IsoInstant;
	  }
	| {
			readonly type: "clock.advanced";
			readonly deltaMs: number;
			readonly fromMs: number;
			readonly toMs: number;
	  }
	| {
			readonly type: "timer.scheduled";
			readonly timerId: string;
			readonly runId: string;
			readonly label?: string;
			readonly idempotencyKey: string;
			readonly delayMs: number;
			readonly scheduledAtMs: number;
			readonly fireAtMs: number;
	  }
	| {
			readonly type: "timer.fired";
			readonly fireId: string;
			readonly timerId: string;
			readonly runId: string;
			readonly atMs: number;
			readonly order: number;
	  }
	| {
			readonly type: "cron.scheduled";
			readonly scheduleId: string;
			readonly everyMs: number;
			readonly startAtMs: number;
	  }
	| {
			readonly type: "cron.fired";
			readonly fireId: string;
			readonly scheduleId: string;
			readonly occurrence: number;
			readonly atMs: number;
			readonly order: number;
	  }
	| {
			readonly type: "queue.enqueued";
			readonly queueName: string;
			readonly messageId: string;
			readonly idempotencyKey: string;
	  }
	| {
			readonly type: "queue.enqueue.deduped";
			readonly queueName: string;
			readonly messageId: string;
			readonly idempotencyKey: string;
	  }
	| {
			readonly type: "queue.completed";
			readonly queueName: string;
			readonly messageId: string;
			readonly idempotencyKey: string;
	  }
	| {
			readonly type: "queue.released";
			readonly queueName: string;
			readonly messageId: string;
			readonly idempotencyKey: string;
	  }
	| {
			readonly type: "queue.redelivered";
			readonly queueName: string;
			readonly messageId: string;
			readonly idempotencyKey: string;
	  };

export interface ClockReplayResult {
	readonly seed: string;
	readonly fireOrder: readonly FireId[];
	readonly finalNow: IsoInstant;
}

/** Read-only clock facet for timestamp queries. */
export interface Clock {
	now(): IsoInstant;
	nowMs(): number;
}

/** Deterministic virtual clock port with sleep, cron, and advance. */
export interface VirtualClock extends Clock {
	sleep(runId: RunId, delayMs: number, options: TimerOptions): ScheduledTimer;
	cron(scheduleId: ScheduleId, spec: IntervalCronSpec): CronSchedule;
	advance(deltaMs: number): readonly FiredTimer[];
	trace(): readonly ClockTraceEntry[];
}

export class ClockParseError extends CoreParseError {
	constructor(
		path: string,
		expected: string,
		received: JsonValue | undefined,
		message?: string,
	) {
		super("HOBO_CORE_CLOCK_PARSE", path, expected, received, message);
		this.name = "ClockParseError";
	}
}

export class NondeterministicClockError extends Error {
	readonly code = "CLOCK_NONDETERMINISTIC" as const;

	constructor(message: string) {
		super(message);
		this.name = "NondeterministicClockError";
	}
}

export function parseIsoInstant(value: string): IsoInstant {
	// SAFETY: assertion required at this I/O or test boundary.
	return isoTimestamp(value, "instant", ClockParseError) as IsoInstant;
}

export function parseTimerId(value: string): TimerId {
	// SAFETY: assertion required at this I/O or test boundary.
	return nonEmptyString(value, "timerId", ClockParseError) as TimerId;
}

export function parseScheduleId(value: string): ScheduleId {
	// SAFETY: assertion required at this I/O or test boundary.
	return nonEmptyString(value, "scheduleId", ClockParseError) as ScheduleId;
}

export function parseFireId(value: string): FireId {
	// SAFETY: assertion required at this I/O or test boundary.
	return nonEmptyString(value, "fireId", ClockParseError) as FireId;
}

export function parseDelayMs(value: number): number {
	return nonNegativeInteger(value, "delayMs", ClockParseError);
}

export function parseCronEveryMs(value: number): number {
	return positiveInteger(value, "everyMs", ClockParseError);
}

export function createScheduledTimer(record: {
	timer_id: string;
	run_id: string;
	idempotency_key: string;
	fire_at: string;
	deduped: boolean;
}): ScheduledTimer {
	return deepFreeze({
		timerId: parseTimerId(record.timer_id),
		runId: parseRunId(record.run_id),
		idempotencyKey: nonEmptyString(
			record.idempotency_key,
			"idempotencyKey",
			ClockParseError,
		),
		fireAt: parseIsoInstant(record.fire_at),
		deduped: record.deduped,
	});
}

export function createCronSchedule(record: {
	schedule_id: string;
	every_ms: number;
	next_fire_at: string;
	deduped: boolean;
}): CronSchedule {
	return deepFreeze({
		scheduleId: parseScheduleId(record.schedule_id),
		everyMs: parseCronEveryMs(record.every_ms),
		nextFireAt: parseIsoInstant(record.next_fire_at),
		deduped: record.deduped,
	});
}

export function createFiredTimer(record: {
	fire_id: string;
	kind: "sleep" | "cron";
	at: string;
	order: number;
	timer_id?: string;
	run_id?: string;
	label?: string;
	schedule_id?: string;
	occurrence?: number;
}): FiredTimer {
	const fired: FiredTimer = {
		fireId: parseFireId(record.fire_id),
		kind: record.kind,
		at: parseIsoInstant(record.at),
		order: nonNegativeInteger(record.order, "order", ClockParseError),
		...(record.timer_id !== undefined
			? { timerId: parseTimerId(record.timer_id) }
			: undefined),
		...(record.run_id !== undefined
			? { runId: parseRunId(record.run_id) }
			: undefined),
		...(record.label !== undefined ? { label: record.label } : undefined),
		...(record.schedule_id !== undefined
			? { scheduleId: parseScheduleId(record.schedule_id) }
			: undefined),
		...(record.occurrence !== undefined
			? {
					occurrence: nonNegativeInteger(
						record.occurrence,
						"occurrence",
						ClockParseError,
					),
				}
			: undefined),
	};
	return deepFreeze(fired);
}

export function createClockReplayResult(record: {
	seed: string;
	fire_order: readonly string[];
	final_now: string;
}): ClockReplayResult {
	return deepFreeze({
		seed: nonEmptyString(record.seed, "seed", ClockParseError),
		fireOrder: record.fire_order.map((fireId) => parseFireId(fireId)),
		finalNow: parseIsoInstant(record.final_now),
	});
}
