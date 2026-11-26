import { type JsonValue } from "./json.js";
export type IsoInstant = string;

export type LeaseState = "pending" | "leased" | "completed" | "released";

export interface EnqueueOptions {
  idempotencyKey: string;
  availableAtMs?: number;
}

export interface DequeueOptions {
  maxMessages?: number;
  visibilityTimeoutMs?: number;
}

export interface EnqueueResult {
  messageId: string;
  idempotencyKey: string;
  deduped: boolean;
}

export interface LeasedMessage {
  messageId: string;
  queueName: string;
  idempotencyKey: string;
  body: JsonValue;
  leaseId: string;
  leaseExpiresAt: IsoInstant;
  deliveryAttempt: number;
}

export interface HandleReport {
  handled: readonly string[];
  deduped: readonly string[];
}

export interface TimerOptions {
  idempotencyKey: string;
  label?: string;
}

export interface IntervalCronSpec {
  everyMs: number;
  startAtMs?: number;
}

export interface ScheduledTimer {
  timerId: string;
  runId: string;
  idempotencyKey: string;
  fireAt: IsoInstant;
  deduped: boolean;
}

// domain-view: parse-produced draft-proof record; its wire form is the CronSchedule proto message in data-models/.
export interface CronSchedule {
  scheduleId: string;
  everyMs: number;
  nextFireAt: IsoInstant;
  deduped: boolean;
}

export interface FiredTimer {
  fireId: string;
  kind: "sleep" | "cron";
  timerId?: string;
  runId?: string;
  label?: string;
  scheduleId?: string;
  occurrence?: number;
  at: IsoInstant;
  order: number;
}

export type ClockTraceEntry =
  | { type: "clock.started"; seed: string; atMs: number; at: IsoInstant }
  | { type: "clock.advanced"; deltaMs: number; fromMs: number; toMs: number }
  | {
      type: "timer.scheduled";
      timerId: string;
      runId: string;
      label?: string;
      idempotencyKey: string;
      delayMs: number;
      scheduledAtMs: number;
      fireAtMs: number;
    }
  | {
      type: "timer.fired";
      fireId: string;
      timerId: string;
      runId: string;
      atMs: number;
      order: number;
    }
  | {
      type: "cron.scheduled";
      scheduleId: string;
      everyMs: number;
      startAtMs: number;
    }
  | {
      type: "cron.fired";
      fireId: string;
      scheduleId: string;
      occurrence: number;
      atMs: number;
      order: number;
    }
  | {
      type: "queue.enqueued";
      queueName: string;
      messageId: string;
      idempotencyKey: string;
    }
  | {
      type: "queue.enqueue.deduped";
      queueName: string;
      messageId: string;
      idempotencyKey: string;
    }
  | {
      type: "queue.completed";
      queueName: string;
      messageId: string;
      idempotencyKey: string;
    }
  | {
      type: "queue.released";
      queueName: string;
      messageId: string;
      idempotencyKey: string;
    }
  | {
      type: "queue.redelivered";
      queueName: string;
      messageId: string;
      idempotencyKey: string;
    };

export interface ClockReplayResult {
  seed: string;
  fireOrder: readonly string[];
  finalNow: IsoInstant;
}

export interface QueueClockSnapshot {
  version: string;
  seed: string;
  nowMs: number;
  nextMessageSeq: number;
  nextLeaseSeq: number;
  nextTimerSeq: number;
  nextFireSeq: number;
  queues: Record<string, { name: string; messages: JsonValue[] }>;
  timers: JsonValue[];
  cronSchedules: JsonValue[];
  trace: ClockTraceEntry[];
}

export interface RuntimeLocalQueueClock {
  queue: QueuePort;
  clock: ClockPort;
  snapshot(): QueueClockSnapshot;
}

export type CreateRuntimeLocalQueueClock = (options?: {
  seed?: string;
  startInstant?: IsoInstant;
  snapshot?: QueueClockSnapshot;
}) => RuntimeLocalQueueClock;

export interface QueuePort {
  enqueue(queueName: string, body: JsonValue, options: EnqueueOptions): Promise<EnqueueResult>;
  dequeue(queueName: string, options?: DequeueOptions): LeasedMessage[];
  handle(
    queueName: string,
    handler: (msg: LeasedMessage) => Promise<void>,
    options?: DequeueOptions,
  ): Promise<HandleReport>;
  complete(messageId: string, leaseId: string): { messageId: string; deduped: boolean };
  release(messageId: string, leaseId: string): { messageId: string };
  simulateRedelivery(messageId: string): { messageId: string };
  signal(
    actorKey: string,
    msg: JsonValue,
    options: EnqueueOptions,
  ): Promise<EnqueueResult & { queueName: string }>;
}

export interface ClockPort {
  now(): IsoInstant;
  nowMs(): number;
  sleep(runId: string, delayMs: number, options: TimerOptions): ScheduledTimer;
  cron(scheduleId: string, spec: IntervalCronSpec): CronSchedule;
  advance(deltaMs: number): readonly FiredTimer[];
  trace(): readonly ClockTraceEntry[];
}

export interface QueueClockConformanceReport {
  contract: string;
  backend: string;
  assertions: {
    queueIdempotencyKeyDedup: "pass" | "fail";
    atLeastOnceRetry: "pass" | "fail";
    redeliveryDedup: "pass" | "fail";
    durableTimerRestart: "pass" | "fail";
    durableCronRestart: "pass" | "fail";
    seededClockReplay: "pass" | "fail";
  };
}
