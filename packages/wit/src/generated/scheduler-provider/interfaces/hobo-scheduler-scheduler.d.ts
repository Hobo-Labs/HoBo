/** @module Interface hobo:scheduler/scheduler@0.1.0 **/
export function every(spec: EverySpec): ScheduleRef;
export function cron(expr: string): ScheduleRef;
/**
 * # Variants
 *
 * ## `"invalid-argument"`
 *
 * ## `"provider-error"`
 */
export type SchedulerErrorCode = 'invalid-argument' | 'provider-error';
export interface SchedulerError {
  code: SchedulerErrorCode,
  message?: string,
  retryable: boolean,
}
export interface EverySpec {
  everyMs: bigint,
  startAtMs?: bigint,
  jitterMs?: bigint,
}
export interface CronSpec {
  expr: string,
  timezone: string,
}
export type TriggerSpec = TriggerSpecEvery | TriggerSpecCron;
export interface TriggerSpecEvery {
  tag: 'every',
  val: EverySpec,
}
export interface TriggerSpecCron {
  tag: 'cron',
  val: CronSpec,
}
export interface ScheduleRef {
  scheduleId: string,
  spec: TriggerSpec,
}
