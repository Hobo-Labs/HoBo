/** @module Interface hobo:queue/queue@0.1.0 **/
export function limits(): Promise<LimitsOutcome>;
export function enqueue(input: EnqueueRequest): Promise<EnqueueOutcome>;
export function dequeue(input: DequeueRequest): Promise<DequeueOutcome>;
export function complete(input: SettlementRequest): Promise<SettlementOutcome>;
export function extendLease(input: ExtendLeaseRequest): Promise<ExtensionOutcome>;
export function release(input: SettlementRequest): Promise<SettlementOutcome>;
export interface QueueLimits {
  nameBytes: number,
  payloadBytes: number,
  attributeCount: number,
  attributeBytes: number,
  batchSize: number,
  delayMs: bigint,
  leaseMs: bigint,
  operationWindowMs: bigint,
  deliveryAttempts: number,
  retainedMessages: number,
  retainedReceipts: number,
}
export type LimitsOutcome = LimitsOutcomeAvailable | LimitsOutcomeUnavailable;
export interface LimitsOutcomeAvailable {
  tag: 'available',
  val: QueueLimits,
}
export interface LimitsOutcomeUnavailable {
  tag: 'unavailable',
}
export interface Operation {
  id: string,
  expiresAtMs: bigint,
}
/**
 * # Variants
 *
 * ## `"invalid-argument"`
 *
 * ## `"unauthorized"`
 *
 * ## `"not-found"`
 *
 * ## `"unsupported"`
 *
 * ## `"operation-conflict"`
 *
 * ## `"message-conflict"`
 *
 * ## `"lease-lost"`
 *
 * ## `"capacity-exceeded"`
 *
 * ## `"unavailable"`
 */
export type RejectionCode = 'invalid-argument' | 'unauthorized' | 'not-found' | 'unsupported' | 'operation-conflict' | 'message-conflict' | 'lease-lost' | 'capacity-exceeded' | 'unavailable';
export interface MessageAttribute {
  key: string,
  value: string,
}
export interface QueueMessage {
  idempotencyKey: string,
  body: Uint8Array,
  attributes: Array<MessageAttribute>,
  availableAtMs?: bigint,
}
export interface EnqueueRequest {
  operation: Operation,
  message: QueueMessage,
}
export interface EnqueueReceipt {
  messageId: string,
  idempotencyKey: string,
}
export interface DequeueRequest {
  operation: Operation,
  maxMessages: number,
  visibilityTimeoutMs: bigint,
}
export interface LeasedMessage {
  messageId: string,
  leaseId: string,
  idempotencyKey: string,
  body: Uint8Array,
  attributes: Array<MessageAttribute>,
  leaseExpiresAtMs: bigint,
  deliveryAttempt: number,
}
export interface SettlementRequest {
  operation: Operation,
  messageId: string,
  leaseId: string,
}
export interface ExtendLeaseRequest {
  operation: Operation,
  messageId: string,
  leaseId: string,
  visibilityTimeoutMs: bigint,
}
export interface SettlementReceipt {
  messageId: string,
  leaseId: string,
}
export type EnqueueOutcome = EnqueueOutcomeCommitted | EnqueueOutcomeRejected | EnqueueOutcomeUnknown | EnqueueOutcomeExpired;
export interface EnqueueOutcomeCommitted {
  tag: 'committed',
  val: EnqueueReceipt,
}
export interface EnqueueOutcomeRejected {
  tag: 'rejected',
  val: RejectionCode,
}
export interface EnqueueOutcomeUnknown {
  tag: 'unknown',
  val: Operation,
}
export interface EnqueueOutcomeExpired {
  tag: 'expired',
  val: Operation,
}
export type DequeueOutcome = DequeueOutcomeCommitted | DequeueOutcomeRejected | DequeueOutcomeUnknown | DequeueOutcomeExpired;
export interface DequeueOutcomeCommitted {
  tag: 'committed',
  val: Array<LeasedMessage>,
}
export interface DequeueOutcomeRejected {
  tag: 'rejected',
  val: RejectionCode,
}
export interface DequeueOutcomeUnknown {
  tag: 'unknown',
  val: Operation,
}
export interface DequeueOutcomeExpired {
  tag: 'expired',
  val: Operation,
}
export type SettlementOutcome = SettlementOutcomeCommitted | SettlementOutcomeRejected | SettlementOutcomeUnknown | SettlementOutcomeExpired;
export interface SettlementOutcomeCommitted {
  tag: 'committed',
  val: SettlementReceipt,
}
export interface SettlementOutcomeRejected {
  tag: 'rejected',
  val: RejectionCode,
}
export interface SettlementOutcomeUnknown {
  tag: 'unknown',
  val: Operation,
}
export interface SettlementOutcomeExpired {
  tag: 'expired',
  val: Operation,
}
export type ExtensionOutcome = ExtensionOutcomeCommitted | ExtensionOutcomeRejected | ExtensionOutcomeUnknown | ExtensionOutcomeExpired;
export interface ExtensionOutcomeCommitted {
  tag: 'committed',
  val: LeasedMessage,
}
export interface ExtensionOutcomeRejected {
  tag: 'rejected',
  val: RejectionCode,
}
export interface ExtensionOutcomeUnknown {
  tag: 'unknown',
  val: Operation,
}
export interface ExtensionOutcomeExpired {
  tag: 'expired',
  val: Operation,
}
