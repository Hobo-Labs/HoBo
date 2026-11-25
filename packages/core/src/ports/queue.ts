import { CoreParseError } from "../errors.js";
import type { JsonValue } from "../json.js";
import {
	deepFreeze,
	isoTimestamp,
	nonEmptyString,
	nonNegativeInteger,
	positiveInteger,
} from "../parse-utils.js";

export const QUEUE_CLOCK_RUNTIME_PORT_CONTRACT_VERSION =
	"hobo.queue-clock-runtime-port/v1";

export type MessageId = string & { readonly __brand: "MessageId" };
export type QueueName = string & { readonly __brand: "QueueName" };
export type LeaseId = string & { readonly __brand: "LeaseId" };
export type IdempotencyKey = string & { readonly __brand: "IdempotencyKey" };
export type ActorKey = string & { readonly __brand: "ActorKey" };

export interface EnqueueOptions {
	readonly idempotencyKey: IdempotencyKey;
	readonly availableAtMs?: number;
}

export interface DequeueOptions {
	readonly maxMessages?: number;
	readonly visibilityTimeoutMs?: number;
}

export interface EnqueueResult {
	readonly messageId: MessageId;
	readonly idempotencyKey: IdempotencyKey;
	readonly deduped: boolean;
}

export interface LeasedMessage<TBody = unknown> {
	readonly messageId: MessageId;
	readonly queueName: QueueName;
	readonly idempotencyKey: IdempotencyKey;
	readonly body: TBody;
	readonly leaseId: LeaseId;
	readonly leaseExpiresAt: string;
	readonly deliveryAttempt: number;
}

export interface HandleReport {
	readonly handled: readonly MessageId[];
	readonly deduped: readonly MessageId[];
}

export interface CompleteResult {
	readonly messageId: MessageId;
	readonly deduped: boolean;
}

export interface ReleaseResult {
	readonly messageId: MessageId;
}

export interface SignalResult extends EnqueueResult {
	readonly queueName: QueueName;
}

export interface Queue {
	enqueue<TBody = unknown>(
		queueName: QueueName,
		body: TBody,
		options: EnqueueOptions,
	): Promise<EnqueueResult>;
	dequeue(
		queueName: QueueName,
		options?: DequeueOptions,
	): readonly LeasedMessage[];
	handle(
		queueName: QueueName,
		handler: (message: LeasedMessage) => Promise<void>,
		options?: DequeueOptions,
	): Promise<HandleReport>;
	complete(messageId: MessageId, leaseId: LeaseId): CompleteResult;
	release(messageId: MessageId, leaseId: LeaseId): ReleaseResult;
	simulateRedelivery(messageId: MessageId): ReleaseResult;
	signal<TMsg = unknown>(
		actorKey: ActorKey,
		msg: TMsg,
		options: EnqueueOptions,
	): Promise<SignalResult>;
}

export class QueueParseError extends CoreParseError {
	constructor(
		path: string,
		expected: string,
		received: JsonValue | undefined,
		message?: string,
	) {
		super("HOBO_CORE_QUEUE_PARSE", path, expected, received, message);
		this.name = "QueueParseError";
	}
}

export class QueueLeaseLostError extends Error {
	readonly code = "QUEUE_LEASE_LOST" as const;

	constructor(message: string) {
		super(message);
		this.name = "QueueLeaseLostError";
	}
}

export function parseMessageId(value: string): MessageId {
	// SAFETY: assertion required at this I/O or test boundary.
	return nonEmptyString(value, "messageId", QueueParseError) as MessageId;
}

export function parseQueueName(value: string): QueueName {
	// SAFETY: assertion required at this I/O or test boundary.
	return nonEmptyString(value, "queueName", QueueParseError) as QueueName;
}

export function parseLeaseId(value: string): LeaseId {
	// SAFETY: assertion required at this I/O or test boundary.
	return nonEmptyString(value, "leaseId", QueueParseError) as LeaseId;
}

export function parseIdempotencyKey(value: string): IdempotencyKey {
	// SAFETY: assertion required at this I/O or test boundary.
	return nonEmptyString(
		value,
		"idempotencyKey",
		QueueParseError,
	) as IdempotencyKey;
}

export function parseActorKey(value: string): ActorKey {
	// SAFETY: assertion required at this I/O or test boundary.
	return nonEmptyString(value, "actorKey", QueueParseError) as ActorKey;
}

export function parseDequeueOptions(
	options: DequeueOptions = {},
): Readonly<{ maxMessages: number; visibilityTimeoutMs: number }> {
	return deepFreeze({
		maxMessages: positiveInteger(
			options.maxMessages ?? 1,
			"maxMessages",
			QueueParseError,
		),
		visibilityTimeoutMs: positiveInteger(
			options.visibilityTimeoutMs ?? 30_000,
			"visibilityTimeoutMs",
			QueueParseError,
		),
	});
}

export function createEnqueueResult(record: {
	message_id: string;
	idempotency_key: string;
	deduped: boolean;
}): EnqueueResult {
	return deepFreeze({
		messageId: parseMessageId(record.message_id),
		idempotencyKey: parseIdempotencyKey(record.idempotency_key),
		deduped: record.deduped,
	});
}

export function createLeasedMessage<TBody>(record: {
	message_id: string;
	queue_name: string;
	idempotency_key: string;
	body: TBody;
	lease_id: string;
	lease_expires_at: string;
	delivery_attempt: number;
}): LeasedMessage<TBody> {
	return deepFreeze({
		messageId: parseMessageId(record.message_id),
		queueName: parseQueueName(record.queue_name),
		idempotencyKey: parseIdempotencyKey(record.idempotency_key),
		body: record.body,
		leaseId: parseLeaseId(record.lease_id),
		leaseExpiresAt: isoTimestamp(
			record.lease_expires_at,
			"leaseExpiresAt",
			QueueParseError,
		),
		deliveryAttempt: nonNegativeInteger(
			record.delivery_attempt,
			"deliveryAttempt",
			QueueParseError,
		),
	});
}
