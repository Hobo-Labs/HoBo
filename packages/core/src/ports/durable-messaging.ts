const hasOwn = Object.hasOwn;

export const DURABLE_MESSAGING_CONTRACT = "hobo.durable-messaging/v1";
export const DURABLE_MESSAGING_WIT_INTERFACE =
	"hobo:durable-messaging/messaging@0.1.0";

export const DURABLE_MESSAGING_LIMITS = Object.freeze({
	nameBytes: 128,
	reasonBytes: 1_024,
	payloadBytes: 65_536,
	attributeCount: 32,
	attributeBytes: 8_192,
	batchSize: 100,
	leaseMs: 86_400_000,
	operationWindowMs: 86_400_000,
	deliveryAttempts: 100,
	retainedMessages: 10_000,
	retainedReceipts: 10_000,
	retainedEvents: 100_000,
	topics: 256,
	subscriptions: 256,
	eventPageSize: 100,
});

export interface DurableMessagingLimits {
	readonly nameBytes: number;
	readonly reasonBytes: number;
	readonly payloadBytes: number;
	readonly attributeCount: number;
	readonly attributeBytes: number;
	readonly batchSize: number;
	readonly leaseMs: number;
	readonly operationWindowMs: number;
	readonly deliveryAttempts: number;
	readonly retainedMessages: number;
	readonly retainedReceipts: number;
	readonly retainedEvents: number;
	readonly topics: number;
	readonly subscriptions: number;
	readonly eventPageSize: number;
}

export interface DurableMessagingOperation {
	readonly id: string;
	readonly expiresAtMs: number;
}

export type DurableMessagingRejectionCode =
	| "invalid-argument"
	| "unauthorized"
	| "not-found"
	| "unsupported"
	| "operation-conflict"
	| "message-conflict"
	| "subscription-conflict"
	| "retention-blocked"
	| "lease-lost"
	| "capacity-exceeded"
	| "unavailable";

export type DurableMessagingOutcome<T> =
	| { readonly status: "committed"; readonly value: T }
	| {
			readonly status: "rejected";
			readonly code: DurableMessagingRejectionCode;
	  }
	| {
			readonly status: "unknown";
			readonly operation: DurableMessagingOperation;
	  }
	| {
			readonly status: "expired";
			readonly operation: DurableMessagingOperation;
	  };

export function durableMessagingOperation(
	expiresAtMs: number,
	nonce: string,
): DurableMessagingOperation {
	if (
		!Number.isSafeInteger(expiresAtMs) ||
		expiresAtMs < 0 ||
		/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: callers may cross a JavaScript boundary despite the static parameter type. */
		typeof nonce !== "string" ||
		!/^[A-Za-z0-9_-]{16,64}$/u.test(nonce)
	)
		throw new TypeError("invalid durable messaging operation");
	return parseDurableMessagingOperation({
		id: `v1.${expiresAtMs}.${nonce}`,
		expiresAtMs,
	});
}

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: operation envelopes enter from an untrusted runtime boundary. */
export function parseDurableMessagingOperation(
	value: unknown,
): DurableMessagingOperation {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new TypeError("invalid operation");
		const fields = Object.getOwnPropertyDescriptors(value);
		const id = hasOwn(fields, "id") ? fields.id : undefined;
		const expiry = hasOwn(fields, "expiresAtMs")
			? fields.expiresAtMs
			: undefined;
		if (
			Object.getOwnPropertySymbols(value).length !== 0 ||
			Object.keys(fields).length !== 2 ||
			id === undefined ||
			!hasOwn(id, "value") ||
			!id.enumerable ||
			typeof id.value !== "string" ||
			expiry === undefined ||
			!hasOwn(expiry, "value") ||
			!expiry.enumerable ||
			typeof expiry.value !== "number" ||
			!Number.isSafeInteger(expiry.value) ||
			expiry.value < 0
		)
			throw new TypeError("invalid operation");
		const match = /^v1\.(0|[1-9][0-9]{0,15})\.([A-Za-z0-9_-]{16,64})$/u.exec(
			id.value,
		);
		if (match === null || match[1] !== String(expiry.value))
			throw new TypeError("invalid operation");
		return Object.freeze({ id: id.value, expiresAtMs: expiry.value });
	} catch {
		throw new TypeError("invalid durable messaging operation");
	}
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

export interface DurableMessagingAttribute {
	readonly key: string;
	readonly value: string;
}

export interface DurableMessagingMessage {
	readonly id: string;
	readonly subject: string;
	readonly payload: Uint8Array;
	readonly attributes: readonly DurableMessagingAttribute[];
}

export type DurableMessagingDeadLetterCause =
	| { readonly kind: "nack"; readonly reason: string }
	| { readonly kind: "lease-expired" };

export interface DurableMessagingDeadLetter {
	readonly sourceTopic: string;
	readonly consumerGroup: string;
	readonly originalMessageId: string;
	readonly originalSequence: number;
	readonly deliveryAttempt: number;
	readonly cause: DurableMessagingDeadLetterCause;
}

export interface DurableMessagingDelivery {
	readonly message: DurableMessagingMessage;
	readonly sequence: number;
	readonly topic: string;
	readonly consumerGroup: string;

	readonly leaseId: string;
	readonly leaseExpiresAtMs: number;
	readonly deliveryAttempt: number;
	readonly deadLetter?: DurableMessagingDeadLetter;
}

export interface DurableMessagingSubscription {
	readonly topic: string;
	readonly consumerGroup: string;
	readonly deadLetterTopic: string;
	readonly maxDeliveryAttempts: number;

	readonly startAt: "earliest" | "latest";
}

export interface DurableMessagingSubscriptionReceipt {
	readonly subscription: DurableMessagingSubscription;

	readonly firstAvailableSequence: number;

	readonly historyTruncated: boolean;
}

export interface DurableMessagingPublishReceipt {
	readonly messageId: string;
	readonly sequence: number;
}

export interface DurableMessagingAckReceipt {
	readonly messageId: string;
	readonly sequence: number;
}

export interface DurableMessagingCompactionReceipt {
	readonly topic: string;
	readonly firstAvailableSequence: number;
	readonly removedMessages: number;
}

export type DurableMessagingNackReceipt =
	| {
			readonly messageId: string;
			readonly sequence: number;
			readonly disposition: "released";
	  }
	| {
			readonly messageId: string;
			readonly sequence: number;
			readonly disposition: "dead-lettered";
			readonly deadLetterMessageId: string;
			readonly deadLetterSequence: number;
	  };

export interface DurableMessagingEvent {
	readonly sequence: number;
	readonly kind:
		| "topic-created"
		| "subscription-created"
		| "published"
		| "leased"
		| "acknowledged"
		| "released"
		| "dead-lettered"
		| "compacted";
	readonly topic: string;
	readonly messageId?: string;
	readonly consumerGroup?: string;
}

export interface DurableMessaging {
	readonly limits: DurableMessagingLimits;
	ensureTopic(input: {
		readonly operation: DurableMessagingOperation;
		readonly topic: string;
	}): Promise<DurableMessagingOutcome<{ readonly topic: string }>>;
	ensureSubscription(input: {
		readonly operation: DurableMessagingOperation;
		readonly subscription: DurableMessagingSubscription;
	}): Promise<DurableMessagingOutcome<DurableMessagingSubscriptionReceipt>>;
	publish(input: {
		readonly operation: DurableMessagingOperation;
		readonly topic: string;
		readonly message: DurableMessagingMessage;
	}): Promise<DurableMessagingOutcome<DurableMessagingPublishReceipt>>;
	consume(input: {
		readonly operation: DurableMessagingOperation;
		readonly topic: string;
		readonly consumerGroup: string;
		readonly maxMessages: number;
		readonly visibilityTimeoutMs: number;
	}): Promise<DurableMessagingOutcome<readonly DurableMessagingDelivery[]>>;
	ack(input: {
		readonly operation: DurableMessagingOperation;
		readonly topic: string;
		readonly consumerGroup: string;
		readonly messageId: string;
		readonly sequence: number;
		readonly leaseId: string;
	}): Promise<DurableMessagingOutcome<DurableMessagingAckReceipt>>;
	nack(input: {
		readonly operation: DurableMessagingOperation;
		readonly topic: string;
		readonly consumerGroup: string;
		readonly messageId: string;
		readonly sequence: number;
		readonly leaseId: string;
		readonly reason: string;
	}): Promise<DurableMessagingOutcome<DurableMessagingNackReceipt>>;
	compact(input: {
		readonly operation: DurableMessagingOperation;
		readonly topic: string;
		readonly throughSequence: number;
	}): Promise<DurableMessagingOutcome<DurableMessagingCompactionReceipt>>;

	events(input: {
		readonly afterSequence: number;
		readonly limit: number;
	}): Promise<
		| {
				readonly status: "ok";
				readonly events: readonly DurableMessagingEvent[];
				readonly firstAvailableSequence: number;
				readonly nextAfterSequence: number;
				readonly hasMore: boolean;
		  }
		| {
				readonly status: "gap";
				readonly firstAvailableSequence: number;
				readonly latestSequence: number;
		  }
		| {
				readonly status: "rejected";
				readonly code: DurableMessagingRejectionCode;
		  }
	>;
}

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: lease tokens cross an untrusted runtime boundary. */
export function parseDurableMessagingLeaseId(
	value: unknown,
	nameBytes: number,
): string {
	if (
		typeof value !== "string" ||
		!Number.isSafeInteger(nameBytes) ||
		nameBytes <= 0 ||
		nameBytes > DURABLE_MESSAGING_LIMITS.nameBytes ||
		value.length === 0 ||
		value.length > nameBytes ||
		/\p{Cc}/u.test(value) ||
		/[\uD800-\uDFFF]/u.test(value) ||
		new TextEncoder().encode(value).length > nameBytes
	)
		throw new TypeError("invalid durable messaging lease ID");
	return value;
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */
