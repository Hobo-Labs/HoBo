/**
 * Provider-neutral, asynchronous messaging with durable operation receipts.
 * This is additive to `Messaging`; it does not implement the legacy WIT port.
 */

// public-contract: stable identifier for the asynchronous durable messaging port.
export const DURABLE_MESSAGING_CONTRACT = "hobo.durable-messaging/v1";
// public-contract: canonical WIT interface exported to SDK consumers.
export const DURABLE_MESSAGING_WIT_INTERFACE =
	"hobo:durable-messaging/messaging@0.1.0";

/** Upper bounds shared by implementations. A provider may reject lower limits. */
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
	readonly subscriptions: number;
	readonly eventPageSize: number;
}

/**
 * The host authenticates and authorizes the tenant and binding separately;
 * an application-supplied name or operation ID is not authorization.
 *
 * Each mutation carries a unique ID and absolute expiry, scoped to its
 * authenticated tenant and messaging instance. Before expiry the provider
 * durably stores the request fingerprint and exact committed receipt. An
 * identical retry returns that receipt; a different request using the ID is
 * rejected. At and after expiry every request with that envelope expires
 * before effects, even after receipt garbage collection. Providers must reject
 * new work on receipt-capacity exhaustion instead of evicting live receipts.
 * The provider must verify expiry at its commit point. The host supplies a
 * trusted, nondecreasing clock and fences prior owners.
 * IDs encode their expiry as `v1.<expires-at-ms>.<nonce>`; an expired ID cannot
 * be reused with a later expiry after its receipt has been collected. A caller
 * must never replace an uncertain operation with a fresh ID.
 */
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

/**
 * `committed` means the named mutation and its receipt are durable.
 * `rejected` guarantees this exact operation did not commit. `unknown` means
 * its outcome cannot be determined. `expired` means this attempt has no
 * effect, but a prior attempt may have committed; it must be reconciled. Retry
 * only the exact operation before expiry, or reconcile through independent
 * host evidence. A lost consume response may have granted leases.
 * A provider may return `rejected` only after ruling out an earlier commit of
 * this exact operation, including under retries and concurrent attempts. If
 * authorization is revoked, the receipt store is unavailable, or capacity
 * cannot be checked without resolving a prior attempt, return `unknown`;
 * never turn an unresolved earlier commit into a definite rejection.
 */
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

/** Construct an expiry-bound operation using a caller-generated unique nonce. */
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

/** Snapshot untrusted data without invoking accessor-backed operation fields. */
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: operation envelopes enter from an untrusted runtime boundary. */
export function parseDurableMessagingOperation(
	value: unknown,
): DurableMessagingOperation {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new TypeError("invalid operation");
		const fields = Object.getOwnPropertyDescriptors(value);
		const id = fields.id;
		const expiry = fields.expiresAtMs;
		if (
			Object.getOwnPropertySymbols(value).length !== 0 ||
			Object.keys(fields).length !== 2 ||
			id === undefined ||
			!("value" in id) ||
			!id.enumerable ||
			typeof id.value !== "string" ||
			expiry === undefined ||
			!("value" in expiry) ||
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

export interface DurableMessagingDeadLetter {
	readonly sourceTopic: string;
	readonly consumerGroup: string;
	readonly originalMessageId: string;
	readonly originalSequence: number;
	readonly deliveryAttempt: number;
	readonly reason: string;
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
	/** `latest` starts after the topic's committed tail at subscription creation. */
	readonly startAt: "earliest" | "latest";
}

export interface DurableMessagingSubscriptionReceipt {
	readonly subscription: DurableMessagingSubscription;
	/** The first retained topic sequence at the creation checkpoint. */
	readonly firstAvailableSequence: number;
	/** True if earlier topic history was explicitly compacted. */
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

/**
 * All methods are asynchronous and run against one authenticated tenant and
 * messaging instance. Names, payloads, attributes, operation windows, leases,
 * batch sizes and retained receipts are bounded. Each operation atomically
 * validates the topic, group, message ID, message sequence and lease together
 * and commits its state and audit facts. Independent groups
 * see independent deliveries; workers in one group compete for each lease.
 * Names and operation IDs must be nonempty, control-free UTF-8 strings within
 * `nameBytes`. Attribute keys must be nonempty and unique, and the total UTF-8
 * bytes of keys and values must fit `attributeBytes`. Payload, reason, batch,
 * attempt, lease and operation-window bounds use `DURABLE_MESSAGING_LIMITS`.
 * Millisecond and sequence values must be nonnegative safe integers.
 * A subscription requires an existing source and distinct dead-letter topic.
 *
 * A nack below the subscription's attempt limit releases the message. At the
 * limit, nack or expiry atomically completes the source-group delivery and
 * publishes the original bytes and attributes, with provenance, to the
 * configured distinct dead-letter topic. Failure to persist the dead letter
 * must retain the source delivery; it must not silently drop the message. A
 * consume that cannot atomically move an exhausted delivery rejects without
 * granting any of that operation's leases.
 * Expired or superseded lease IDs are rejected without changing either lease.
 * External handler side effects still need application-level idempotency.
 * A topic rejects a duplicate retained message ID rather than replacing its
 * contents. Published topic sequences are unique, positive and monotonic,
 * including after compaction. Existing subscription settings cannot be changed
 * by another ensure call. Providers expose capacity exhaustion explicitly;
 * they must not discard messages or unexpired receipts to admit new work.
 *
 * Authorized `compact` removes only a contiguous prefix for which every
 * subscription responsible for each message has durably acknowledged it or
 * completed dead-letter transfer. An unsettled or leased delivery blocks the
 * entire requested compaction. The atomic receipt gives the new retained floor;
 * previously committed publication receipts remain replayable until expiry.
 * A later `earliest` subscription starts at that floor and explicitly reports
 * whether prior history was truncated. A `latest` subscription starts after
 * the current tail and is not responsible for earlier messages. Message IDs
 * may be reused only after their earlier retained message has been compacted;
 * their topic sequences and lease IDs must remain distinct.
 * A new topic's floor is 1; when empty its floor is the last published
 * sequence plus 1. A checkpoint beyond the committed topic tail is invalid.
 * Compacting an already removed prefix is a no-op that returns the current
 * floor. If the next sequence would exceed safe integer range, publication is
 * rejected rather than reusing an earlier sequence.
 */
export interface DurableMessaging {
	/** Actual positive limits, at or below `DURABLE_MESSAGING_LIMITS`. */
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
	/** A retention gap is explicit; a read never mutates durable state. */
	events(input: {
		readonly afterSequence: number;
		readonly limit: number;
	}): Promise<
		| {
				readonly status: "ok";
				readonly events: readonly DurableMessagingEvent[];
				readonly firstAvailableSequence: number;
		  }
		| {
				readonly status: "rejected";
				readonly code: DurableMessagingRejectionCode;
		  }
	>;
}
