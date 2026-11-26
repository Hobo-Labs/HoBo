/** @module Interface hobo:queue/queue@0.1.0 **/
export function enqueue(message: QueueMessage): EnqueueResult;
export function dequeue(request: DequeueRequest): Array<LeasedMessage>;
export function complete(messageId: string, leaseId: string): void;
export function extendLease(messageId: string, leaseId: string, visibilityTimeoutMs: bigint): LeasedMessage;
export function release(messageId: string, leaseId: string): void;
/**
 * # Variants
 *
 * ## `"invalid-argument"`
 *
 * ## `"not-found"`
 *
 * ## `"lease-lost"`
 *
 * ## `"deadline-exceeded"`
 *
 * ## `"provider-error"`
 */
export type QueueErrorCode = 'invalid-argument' | 'not-found' | 'lease-lost' | 'deadline-exceeded' | 'provider-error';
export interface QueueError {
  code: QueueErrorCode,
  message?: string,
  retryable: boolean,
}
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
export interface EnqueueResult {
  messageId: string,
  idempotencyKey: string,
}
export interface DequeueRequest {
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
