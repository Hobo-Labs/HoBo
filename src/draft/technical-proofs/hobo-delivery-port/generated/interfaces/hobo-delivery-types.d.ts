/** @module Interface hobo:delivery/types@0.1.0 **/
/**
 * # Variants
 *
 * ## `"recreate"`
 *
 * ## `"blue-green"`
 *
 * ## `"canary"`
 *
 * ## `"progressive"`
 */
export type StrategyKind = 'recreate' | 'blue-green' | 'canary' | 'progressive';
/**
 * # Variants
 *
 * ## `"pending"`
 *
 * ## `"running"`
 *
 * ## `"promoted"`
 *
 * ## `"rolled-back"`
 *
 * ## `"failed"`
 */
export type RolloutState = 'pending' | 'running' | 'promoted' | 'rolled-back' | 'failed';
/**
 * # Variants
 *
 * ## `"recreate"`
 *
 * ## `"blue-green"`
 *
 * ## `"canary"`
 *
 * ## `"progressive"`
 *
 * ## `"automated-rollback"`
 */
export type RolloutCapability = 'recreate' | 'blue-green' | 'canary' | 'progressive' | 'automated-rollback';
export interface GateRef {
  kind: string,
  id: string,
}
export interface RolloutStep {
  name: string,
  weight: number,
  gateRefs: Array<GateRef>,
}
export interface AnalysisWindow {
  durationSeconds: number,
  minSamples: number,
}
export interface PromotionPolicy {
  strategy: StrategyKind,
  steps: Array<RolloutStep>,
  analysisWindow?: AnalysisWindow,
  requiredCapabilities: Array<RolloutCapability>,
}
export interface RolloutTarget {
  service: string,
  fromVersion: string,
  toVersion: string,
}
export interface StartRolloutRequest {
  rolloutId: string,
  runId: string,
  tenant: string,
  target: RolloutTarget,
  policy: PromotionPolicy,
}
export interface RolloutCommand {
  rolloutId: string,
  step?: string,
  reason?: string,
}
export interface PlanWarning {
  code: string,
  message: string,
  missingCapability?: RolloutCapability,
}
export interface RolloutStatus {
  rolloutId: string,
  state: RolloutState,
  currentStep?: string,
  warnings: Array<PlanWarning>,
}
export interface RolloutStarted {
  rolloutId: string,
  runId: string,
  tenant: string,
  target: RolloutTarget,
  policy: PromotionPolicy,
  warnings: Array<PlanWarning>,
}
export interface RolloutStepped {
  rolloutId: string,
  step: RolloutStep,
  state: RolloutState,
}
export interface RolloutPromoted {
  rolloutId: string,
  finalVersion: string,
}
export interface RolloutRolledBack {
  rolloutId: string,
  restoredVersion: string,
  reason: string,
}
export interface RolloutFailed {
  rolloutId: string,
  state: RolloutState,
  reason: string,
  dangling: boolean,
}
export type RolloutEvent = RolloutEventStarted | RolloutEventStepped | RolloutEventPromoted | RolloutEventRolledBack | RolloutEventFailed;
export interface RolloutEventStarted {
  tag: 'started',
  val: RolloutStarted,
}
export interface RolloutEventStepped {
  tag: 'stepped',
  val: RolloutStepped,
}
export interface RolloutEventPromoted {
  tag: 'promoted',
  val: RolloutPromoted,
}
export interface RolloutEventRolledBack {
  tag: 'rolled-back',
  val: RolloutRolledBack,
}
export interface RolloutEventFailed {
  tag: 'failed',
  val: RolloutFailed,
}
export interface RolloutCommandResult {
  status: RolloutStatus,
  events: Array<RolloutEvent>,
}
