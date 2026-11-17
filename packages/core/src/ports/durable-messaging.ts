/**
 * Provider-neutral, asynchronous messaging with durable operation receipts.
 * This is additive to `Messaging`; it does not implement the legacy WIT port.
 */

// public-contract: stable identifier for the asynchronous durable messaging port.
export const DURABLE_MESSAGING_CONTRACT = "hobo.durable-messaging/v1";
// public-contract: canonical WIT interface exported to SDK consumers.
export const DURABLE_MESSAGING_WIT_INTERFACE =
	"hobo:durable-messaging/messaging@0.1.0";

/**
 * Upper bounds shared by implementations. A provider may publish lower limits.
 * Topic, subscription, retained message, receipt and event counts are totals
 * per authenticated tenant and durable instance, across all its topics.
 */
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

/**
 * The host authenticates and authorizes the tenant and binding separately;
 * an application-supplied name or operation ID is not authorization.
 *
 * Each mutation carries a unique ID and absolute expiry, scoped to its
 * authenticated tenant and messaging instance. Before expiry the provider
 * durably stores the request fingerprint and exact terminal committed or
 * rejected receipt. An identical retry returns that receipt; a different
 * request using the ID is rejected as an operation conflict, with the existing
 * receipt fencing the conflicting request. At and after expiry every request
 * with that envelope expires
 * before effects, even after receipt garbage collection. Providers must not
 * evict live receipts. If receipt-capacity exhaustion prevents fencing a new
 * operation, its outcome is unknown rather than a definite rejection.
 * The provider verifies expiry inside the serializable transaction before
 * mutation and receipt installation. A transaction started before expiry can
 * commit after it; a later retry still expires and cannot start a new mutation.
 * The host supplies a trusted, nondecreasing clock and fences prior owners.
 * IDs encode their expiry as `v1.<expires-at-ms>.<nonce>`; an expired ID cannot
 * be reused with a later expiry after its receipt has been collected. A caller
 * must never replace an uncertain operation with a fresh ID.
 * Retries must reach the same authenticated tenant and durable instance. A
 * new process generation may resolve them only through an independently
 * verified shared or atomically transferred journal with old owners fenced.
 * If that authority cannot be established, the outcome remains unknown.
 * A fingerprint binds the method, authenticated tenant and durable instance,
 * and every semantic request field, including message bytes and attributes,
 * topic, group, sequence, lease, subscription settings and nack reason. The
 * caller's mutable input must be detached before any asynchronous boundary.
 * Receipt lookup precedes lease, quota and dynamic policy checks; a committed
 * consume, ack or nack retry replays its original receipt even after its lease
 * has expired, provided the operation itself has not expired.
 * Audit events do not carry authenticated operation fingerprints and cannot
 * establish whether an unknown or expired operation committed. Resolution
 * after receipt expiry needs independent host reconciliation against the
 * authoritative journal; absence of an audit event is not evidence of failure.
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
 * this exact operation and durably recording the terminal rejection until
 * expiry. Identical retries replay that rejection; callers may use a fresh ID
 * only after receiving a definite rejection. If authorization is revoked, the
 * receipt store is unavailable, or capacity
 * cannot be checked without resolving a prior attempt, return `unknown`;
 * never turn an unresolved earlier commit into a definite rejection.
 * A permanently malformed operation envelope may be rejected without a
 * receipt only when that exact envelope can never satisfy the ID/expiry
 * grammar. For a valid envelope, all definite dynamic and input rejections
 * require a terminal receipt, or else the outcome is unknown.
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
 * batch sizes and retained receipts are bounded. All mutations are linearizable
 * in one authenticated instance, including subscription creation, compaction,
 * publish, consume, settlement and receipt state; snapshot isolation alone is
 * insufficient. Each operation atomically validates the topic, group, message
 * ID, message sequence and lease together and commits its state and audit
 * facts. Independent groups see independent deliveries; workers in one group
 * compete for each lease.
 * Names and operation IDs must be nonempty, control-free Unicode scalar strings
 * within `nameBytes` of UTF-8; unpaired surrogates are invalid. Attribute keys
 * must be nonempty and unique, all attribute values must be Unicode scalar
 * strings, and the total UTF-8 bytes of keys and values must fit
 * `attributeBytes`. Payload, reason, batch,
 * attempt, lease and operation-window bounds use `DURABLE_MESSAGING_LIMITS`.
 * Millisecond and sequence values must be nonnegative safe integers.
 * These TypeScript interfaces do not parse a transport boundary. Every SDK,
 * component host and provider must bound, detach and validate requests and
 * responses, including receipt scope, operation identity and delivery/lease
 * consistency, before treating any provider response as evidence.
 * A subscription requires an existing source and distinct dead-letter topic.
 * A lease deadline is the trusted timestamp read inside its serializable
 * consume transaction plus the requested visibility timeout; overflow is
 * rejected. Each new lease increments its delivery attempt without wrapping.
 * Commit or receipt delivery can occur after the lease deadline. An identical
 * consume retry replays its original receipt, even if that lease is now expired;
 * it never extends or replaces it. The host must check current authorization
 * and lease ownership before any fenced handler effect. Ack and nack reject an
 * expired or superseded lease, and external side effects remain at-least-once.
 *
 * A nack below the subscription's attempt limit releases the message. At the
 * limit, nack atomically completes the source-group delivery and publishes the
 * original bytes and attributes, with provenance, to the configured distinct
 * dead-letter topic. A lease that expires at the limit is transferred by the
 * next authorized consume or provider scheduler transaction for that group
 * before it can be leased again; expiry alone does not promise a background
 * worker. Until transfer commits, the source remains an unsettled obligation,
 * audit reads do not report it settled and compaction must remain blocked.
 * Failure to persist the dead letter must retain the source delivery; it must
 * not silently drop the message. A consume that cannot atomically move an
 * exhausted delivery rejects without granting any of that operation's leases,
 * or returns unknown if a terminal rejection cannot be durably fenced.
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
	/**
	 * Audit sequences are positive, monotonic and never reused, even after
	 * retention or restart. If the next sequence exceeds the safe integer range,
	 * a mutation requiring an audit event must fail without an effect. Pages are
	 * ordered and contiguous. `nextAfterSequence`
	 * is the last returned sequence, or the input cursor for an empty page;
	 * `hasMore` refers to the tail observed by this read. A cursor older than
	 * `firstAvailableSequence - 1` returns `gap`, never a silently partial page.
	 * A cursor beyond the observed tail is invalid. A read never mutates state.
	 */
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
