import {
	type ActorKey,
	type DequeueOptions,
	type EnqueueOptions,
	type EnqueueResult,
	type HandleReport,
	type LeasedMessage,
	type LeaseId,
	type MessageId,
	parseDequeueOptions,
	parseIdempotencyKey,
	parseLeaseId,
	parseMessageId,
	parseQueueName,
	type Queue,
	QueueLeaseLostError,
	type QueueName,
} from "@hobo/core";

import { cloneAsJson } from "./json.js";
import {
	appendTrace,
	cloneStore,
	findMessageById,
	formatInstant,
	getQueue,
	isAvailableForLease,
	normalizeNonNegativeInteger,
	type QueueClockStore,
	type QueueMessageRecord,
} from "./queue-clock-store.js";

export function createLocalQueue(store: QueueClockStore): Queue {
	return Object.freeze({
		async enqueue<TBody>(
			queueName: QueueName,
			body: TBody,
			options: EnqueueOptions,
		): Promise<EnqueueResult> {
			const queue = getQueue(store, queueName);
			const idempotencyKey = options.idempotencyKey;
			const previous = queue.messages.find(
				(message) => message.idempotencyKey === idempotencyKey,
			);

			if (previous) {
				appendTrace(store, {
					type: "queue.enqueue.deduped",
					queueName: queue.name,
					messageId: previous.messageId,
					idempotencyKey,
				});
				return queueEnqueueResult(previous, true);
			}

			const message: QueueMessageRecord = {
				messageId: `msg-${store.nextMessageSeq++}`,
				queueName: queue.name,
				idempotencyKey,
				body: cloneAsJson(body),
				state: "pending",
				availableAtMs: normalizeNonNegativeInteger(
					options.availableAtMs ?? store.nowMs,
					"options.availableAtMs",
				),
				deliveryAttempt: 0,
				leaseId: null,
				leaseExpiresAtMs: null,
				completedAtMs: null,
				processing: false,
			};
			queue.messages.push(message);
			appendTrace(store, {
				type: "queue.enqueued",
				queueName: queue.name,
				messageId: message.messageId,
				idempotencyKey,
			});

			return queueEnqueueResult(message, false);
		},

		dequeue(queueName: QueueName, options: DequeueOptions = {}) {
			const parsed = parseDequeueOptions(options);
			const queue = getQueue(store, queueName);
			const leased: LeasedMessage[] = [];

			for (const message of queue.messages) {
				if (leased.length >= parsed.maxMessages) {
					break;
				}
				if (!isAvailableForLease(message, store.nowMs)) {
					continue;
				}

				message.state = "leased";
				message.deliveryAttempt += 1;
				message.leaseId = `lease-${store.nextLeaseSeq++}`;
				message.leaseExpiresAtMs = store.nowMs + parsed.visibilityTimeoutMs;
				leased.push(publicMessage(message));
			}

			return Object.freeze(leased);
		},

		async handle(
			queueName: QueueName,
			handler: (message: LeasedMessage) => Promise<void>,
			options: DequeueOptions = {},
		): Promise<HandleReport> {
			if (!(handler instanceof Function)) {
				throw new TypeError("handler must be a function");
			}
			const leased = this.dequeue(queueName, options);
			const handled: MessageId[] = [];
			const deduped: MessageId[] = [];

			for (const message of leased) {
				const record = findMessageById(store, message.messageId);
				if (record.completedAtMs !== null) {
					this.complete(message.messageId, message.leaseId);
					deduped.push(message.messageId);
					continue;
				}

				try {
					record.processing = true;
					await handler(message);
					this.complete(message.messageId, message.leaseId);
					handled.push(message.messageId);
				} catch (error) {
					record.processing = false;
					releaseForRetry(record, store, message.leaseId);
					throw error;
				}
			}

			return Object.freeze({
				handled: Object.freeze(handled),
				deduped: Object.freeze(deduped),
			});
		},

		complete(messageId: MessageId, leaseId: LeaseId) {
			const message = findMessageById(store, messageId);
			if (message.completedAtMs !== null) {
				message.state = "completed";
				message.leaseId = null;
				message.leaseExpiresAtMs = null;
				message.processing = false;
				return Object.freeze({
					messageId: parseMessageId(message.messageId),
					deduped: true,
				});
			}
			validateLease(message, leaseId);
			message.state = "completed";
			message.completedAtMs = store.nowMs;
			message.leaseId = null;
			message.leaseExpiresAtMs = null;
			message.processing = false;
			appendTrace(store, {
				type: "queue.completed",
				queueName: message.queueName,
				messageId: message.messageId,
				idempotencyKey: message.idempotencyKey,
			});
			return Object.freeze({
				messageId: parseMessageId(message.messageId),
				deduped: false,
			});
		},

		release(messageId: MessageId, leaseId: LeaseId) {
			const message = findMessageById(store, messageId);
			validateLease(message, leaseId);
			releaseForRetry(message, store);
			return Object.freeze({ messageId: parseMessageId(message.messageId) });
		},

		simulateRedelivery(messageId: MessageId) {
			const message = findMessageById(store, messageId);
			message.state = "pending";
			message.availableAtMs = store.nowMs;
			message.leaseId = null;
			message.leaseExpiresAtMs = null;
			appendTrace(store, {
				type: "queue.redelivered",
				queueName: message.queueName,
				messageId: message.messageId,
				idempotencyKey: message.idempotencyKey,
			});
			return Object.freeze({ messageId: parseMessageId(message.messageId) });
		},

		async signal<TMsg>(actorKey: ActorKey, msg: TMsg, options: EnqueueOptions) {
			const key = actorKey;
			const idempotencyKey = options.idempotencyKey;
			const queueName = parseQueueName(`actor:${key}`);
			const result = await this.enqueue(
				queueName,
				{ actorKey: key, msg: cloneStore(msg) },
				{ idempotencyKey },
			);
			return Object.freeze({ ...result, queueName });
		},
	});
}

function publicMessage(message: QueueMessageRecord): LeasedMessage {
	return Object.freeze({
		messageId: parseMessageId(message.messageId),
		queueName: parseQueueName(message.queueName),
		idempotencyKey: parseIdempotencyKey(message.idempotencyKey),
		body: cloneStore(message.body),
		leaseId: parseLeaseId(message.leaseId ?? ""),
		leaseExpiresAt: formatInstant(
			message.leaseExpiresAtMs ?? storeFallbackMs(message),
		),
		deliveryAttempt: message.deliveryAttempt,
	});
}

function storeFallbackMs(message: QueueMessageRecord): number {
	return message.leaseExpiresAtMs ?? 0;
}

function queueEnqueueResult(
	message: QueueMessageRecord,
	deduped: boolean,
): EnqueueResult {
	return Object.freeze({
		messageId: parseMessageId(message.messageId),
		idempotencyKey: parseIdempotencyKey(message.idempotencyKey),
		deduped,
	});
}

function validateLease(message: QueueMessageRecord, leaseId: LeaseId): void {
	const lease = leaseId;
	if (message.leaseId !== lease) {
		throw new QueueLeaseLostError(`lease lost for ${message.messageId}`);
	}
}

function releaseForRetry(
	message: QueueMessageRecord,
	store: QueueClockStore,
	// SAFETY: assertion to `message.leaseId as LeaseId | null` is required at this boundary.
	leaseId: LeaseId | null = message.leaseId as LeaseId | null,
): boolean {
	if (message.leaseId !== leaseId) {
		return false;
	}
	message.state = "pending";
	message.availableAtMs = store.nowMs;
	message.leaseId = null;
	message.leaseExpiresAtMs = null;
	message.processing = false;
	appendTrace(store, {
		type: "queue.released",
		queueName: message.queueName,
		messageId: message.messageId,
		idempotencyKey: message.idempotencyKey,
	});
	return true;
}
