/** @module Interface hobo:durable-messaging/messaging@0.1.0 **/
export function limits(): MessagingLimits;
export function ensureTopic(input: TopicRequest): Promise<TopicOutcome>;
export function ensureSubscription(input: SubscriptionRequest): Promise<SubscriptionOutcome>;
export function publish(input: PublishRequest): Promise<PublishOutcome>;
export function consume(input: ConsumeRequest): Promise<ConsumeOutcome>;
export function ack(input: AcknowledgementRequest): Promise<MessageOutcome>;
export function nack(input: RejectionRequest): Promise<NackOutcome>;
export function compact(input: CompactionRequest): Promise<CompactionOutcome>;
export function events(input: EventRequest): Promise<EventOutcome>;
export interface MessagingLimits {
  nameBytes: number,
  reasonBytes: number,
  payloadBytes: number,
  attributeCount: number,
  attributeBytes: number,
  batchSize: number,
  leaseMs: bigint,
  operationWindowMs: bigint,
  deliveryAttempts: number,
  retainedMessages: number,
  retainedReceipts: number,
  retainedEvents: number,
  topics: number,
  subscriptions: number,
  eventPageSize: number,
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
 * ## `"subscription-conflict"`
 *
 * ## `"retention-blocked"`
 *
 * ## `"lease-lost"`
 *
 * ## `"capacity-exceeded"`
 *
 * ## `"unavailable"`
 */
export type RejectionCode = 'invalid-argument' | 'unauthorized' | 'not-found' | 'unsupported' | 'operation-conflict' | 'message-conflict' | 'subscription-conflict' | 'retention-blocked' | 'lease-lost' | 'capacity-exceeded' | 'unavailable';
export interface Attribute {
  key: string,
  value: string,
}
export interface Message {
  id: string,
  subject: string,
  payload: Uint8Array,
  attributes: Array<Attribute>,
}
export type DeadLetterCause = DeadLetterCauseNack | DeadLetterCauseLeaseExpired;
export interface DeadLetterCauseNack {
  tag: 'nack',
  val: string,
}
export interface DeadLetterCauseLeaseExpired {
  tag: 'lease-expired',
}
export interface DeadLetter {
  sourceTopic: string,
  consumerGroup: string,
  originalMessageId: string,
  originalSequence: bigint,
  deliveryAttempt: number,
  cause: DeadLetterCause,
}
export interface Delivery {
  message: Message,
  sequence: bigint,
  topic: string,
  consumerGroup: string,
  leaseId: string,
  leaseExpiresAtMs: bigint,
  deliveryAttempt: number,
  deadLetter?: DeadLetter,
}
/**
 * # Variants
 *
 * ## `"earliest"`
 *
 * ## `"latest"`
 */
export type StartAt = 'earliest' | 'latest';
export interface Subscription {
  topic: string,
  consumerGroup: string,
  deadLetterTopic: string,
  maxDeliveryAttempts: number,
  startAt: StartAt,
}
export interface TopicRequest {
  operation: Operation,
  topic: string,
}
export interface SubscriptionRequest {
  operation: Operation,
  subscription: Subscription,
}
export interface PublishRequest {
  operation: Operation,
  topic: string,
  message: Message,
}
export interface ConsumeRequest {
  operation: Operation,
  topic: string,
  consumerGroup: string,
  maxMessages: number,
  visibilityTimeoutMs: bigint,
}
export interface AcknowledgementRequest {
  operation: Operation,
  topic: string,
  consumerGroup: string,
  messageId: string,
  sequence: bigint,
  leaseId: string,
}
export interface RejectionRequest {
  operation: Operation,
  topic: string,
  consumerGroup: string,
  messageId: string,
  sequence: bigint,
  leaseId: string,
  reason: string,
}
export interface CompactionRequest {
  operation: Operation,
  topic: string,
  throughSequence: bigint,
}
export interface TopicReceipt {
  topic: string,
}
export interface MessageReceipt {
  messageId: string,
  sequence: bigint,
}
export interface PublishReceipt {
  messageId: string,
  sequence: bigint,
}
export interface SubscriptionReceipt {
  subscription: Subscription,
  firstAvailableSequence: bigint,
  historyTruncated: boolean,
}
export interface CompactionReceipt {
  topic: string,
  firstAvailableSequence: bigint,
  removedMessages: number,
}
export interface DeadLetterReceipt {
  messageId: string,
  sequence: bigint,
  deadLetterMessageId: string,
  deadLetterSequence: bigint,
}
export type TopicOutcome = TopicOutcomeCommitted | TopicOutcomeRejected | TopicOutcomeUnknown | TopicOutcomeExpired;
export interface TopicOutcomeCommitted {
  tag: 'committed',
  val: TopicReceipt,
}
export interface TopicOutcomeRejected {
  tag: 'rejected',
  val: RejectionCode,
}
export interface TopicOutcomeUnknown {
  tag: 'unknown',
  val: Operation,
}
export interface TopicOutcomeExpired {
  tag: 'expired',
  val: Operation,
}
export type SubscriptionOutcome = SubscriptionOutcomeCommitted | SubscriptionOutcomeRejected | SubscriptionOutcomeUnknown | SubscriptionOutcomeExpired;
export interface SubscriptionOutcomeCommitted {
  tag: 'committed',
  val: SubscriptionReceipt,
}
export interface SubscriptionOutcomeRejected {
  tag: 'rejected',
  val: RejectionCode,
}
export interface SubscriptionOutcomeUnknown {
  tag: 'unknown',
  val: Operation,
}
export interface SubscriptionOutcomeExpired {
  tag: 'expired',
  val: Operation,
}
export type MessageOutcome = MessageOutcomeCommitted | MessageOutcomeRejected | MessageOutcomeUnknown | MessageOutcomeExpired;
export interface MessageOutcomeCommitted {
  tag: 'committed',
  val: MessageReceipt,
}
export interface MessageOutcomeRejected {
  tag: 'rejected',
  val: RejectionCode,
}
export interface MessageOutcomeUnknown {
  tag: 'unknown',
  val: Operation,
}
export interface MessageOutcomeExpired {
  tag: 'expired',
  val: Operation,
}
export type PublishOutcome = PublishOutcomeCommitted | PublishOutcomeRejected | PublishOutcomeUnknown | PublishOutcomeExpired;
export interface PublishOutcomeCommitted {
  tag: 'committed',
  val: PublishReceipt,
}
export interface PublishOutcomeRejected {
  tag: 'rejected',
  val: RejectionCode,
}
export interface PublishOutcomeUnknown {
  tag: 'unknown',
  val: Operation,
}
export interface PublishOutcomeExpired {
  tag: 'expired',
  val: Operation,
}
export type ConsumeOutcome = ConsumeOutcomeCommitted | ConsumeOutcomeRejected | ConsumeOutcomeUnknown | ConsumeOutcomeExpired;
export interface ConsumeOutcomeCommitted {
  tag: 'committed',
  val: Array<Delivery>,
}
export interface ConsumeOutcomeRejected {
  tag: 'rejected',
  val: RejectionCode,
}
export interface ConsumeOutcomeUnknown {
  tag: 'unknown',
  val: Operation,
}
export interface ConsumeOutcomeExpired {
  tag: 'expired',
  val: Operation,
}
export type NackReceipt = NackReceiptReleased | NackReceiptDeadLettered;
export interface NackReceiptReleased {
  tag: 'released',
  val: MessageReceipt,
}
export interface NackReceiptDeadLettered {
  tag: 'dead-lettered',
  val: DeadLetterReceipt,
}
export type NackOutcome = NackOutcomeCommitted | NackOutcomeRejected | NackOutcomeUnknown | NackOutcomeExpired;
export interface NackOutcomeCommitted {
  tag: 'committed',
  val: NackReceipt,
}
export interface NackOutcomeRejected {
  tag: 'rejected',
  val: RejectionCode,
}
export interface NackOutcomeUnknown {
  tag: 'unknown',
  val: Operation,
}
export interface NackOutcomeExpired {
  tag: 'expired',
  val: Operation,
}
export type CompactionOutcome = CompactionOutcomeCommitted | CompactionOutcomeRejected | CompactionOutcomeUnknown | CompactionOutcomeExpired;
export interface CompactionOutcomeCommitted {
  tag: 'committed',
  val: CompactionReceipt,
}
export interface CompactionOutcomeRejected {
  tag: 'rejected',
  val: RejectionCode,
}
export interface CompactionOutcomeUnknown {
  tag: 'unknown',
  val: Operation,
}
export interface CompactionOutcomeExpired {
  tag: 'expired',
  val: Operation,
}
/**
 * # Variants
 *
 * ## `"topic-created"`
 *
 * ## `"subscription-created"`
 *
 * ## `"published"`
 *
 * ## `"leased"`
 *
 * ## `"acknowledged"`
 *
 * ## `"released"`
 *
 * ## `"dead-lettered"`
 *
 * ## `"compacted"`
 */
export type EventKind = 'topic-created' | 'subscription-created' | 'published' | 'leased' | 'acknowledged' | 'released' | 'dead-lettered' | 'compacted';
export interface Event {
  sequence: bigint,
  kind: EventKind,
  topic: string,
  messageId?: string,
  consumerGroup?: string,
}
export interface EventRequest {
  afterSequence: bigint,
  limit: number,
}
export interface EventPage {
  events: Array<Event>,
  firstAvailableSequence: bigint,
  nextAfterSequence: bigint,
  hasMore: boolean,
}
export interface EventGap {
  firstAvailableSequence: bigint,
  latestSequence: bigint,
}
export type EventOutcome = EventOutcomeOk | EventOutcomeGap | EventOutcomeRejected;
export interface EventOutcomeOk {
  tag: 'ok',
  val: EventPage,
}
export interface EventOutcomeGap {
  tag: 'gap',
  val: EventGap,
}
export interface EventOutcomeRejected {
  tag: 'rejected',
  val: RejectionCode,
}
