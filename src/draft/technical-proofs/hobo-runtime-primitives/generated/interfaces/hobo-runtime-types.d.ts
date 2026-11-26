/** @module Interface hobo:runtime/types@0.1.0 **/
export type Bytes = Uint8Array;
export interface Event {
  eventType: string,
  data: Bytes,
  streamId?: string,
  idempotencyKey?: string,
}
export interface StepOpts {
  retries: number,
  timeoutMs: bigint,
  idempotencyKey?: string,
}
export type RuntimeError = RuntimeErrorRetryable | RuntimeErrorFatal | RuntimeErrorCancelled | RuntimeErrorVersionIncompatible | RuntimeErrorAmbiguousCommit;
export interface RuntimeErrorRetryable {
  tag: 'retryable',
  val: string,
}
export interface RuntimeErrorFatal {
  tag: 'fatal',
  val: string,
}
export interface RuntimeErrorCancelled {
  tag: 'cancelled',
  val: string,
}
export interface RuntimeErrorVersionIncompatible {
  tag: 'version-incompatible',
  val: string,
}
export interface RuntimeErrorAmbiguousCommit {
  tag: 'ambiguous-commit',
  val: string,
}
export interface RunHandle {
  runId: string,
}
export interface HookToken {
  id: string,
}
export interface ActorKey {
  typeName: string,
  key: string,
}
export interface StateEntry {
  value: Bytes,
  expectedSeq: bigint,
  fenceToken: string,
}
export interface Compensation {
  name: string,
  input: Bytes,
}
export interface Message {
  name: string,
  data: Bytes,
  idempotencyKey?: string,
}
export interface AgentMessage {
  role: string,
  content: string,
}
export interface ToolCall {
  name: string,
  input: Bytes,
  idempotencyKey?: string,
}
export interface TokenRequest {
  provider: string,
  scope: string,
  audience?: string,
}
export interface TokenHandle {
  ref: string,
  expiresAtSeq?: bigint,
}
export interface SubscriptionFilter {
  eventTypes: Array<string>,
  fromSeq?: bigint,
}

export class Subscription {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  next(): Event | undefined;
  cancel(): void;
}
