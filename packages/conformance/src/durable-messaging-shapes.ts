import { types as utilTypes } from "node:util";
import {
	DURABLE_MESSAGING_LIMITS,
	type DurableMessaging,
	type DurableMessagingDeadLetter,
	type DurableMessagingDelivery,
	type DurableMessagingEvent,
	type DurableMessagingLimits,
	type DurableMessagingMessage,
	type DurableMessagingOutcome,
	type DurableMessagingSubscription,
	parseDurableMessagingLeaseId,
	parseDurableMessagingOperation,
} from "@hobo/core";

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof -- SAFETY: provider fields remain unknown until each boundary parser validates them. */
class ProxyProviderValue extends TypeError {}

export class InvalidProviderLimit extends TypeError {
	constructor(readonly key: keyof DurableMessagingLimits) {
		super("invalid provider limit");
	}
}

function object(value: unknown): object {
	if (utilTypes.isProxy(value)) throw new ProxyProviderValue("provider proxy");
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new TypeError("invalid provider record");
	return value;
}

function field(value: unknown, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(object(value), key);
	if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
		throw new TypeError("missing provider field");
	return descriptor.value;
}

function optional(value: unknown, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(object(value), key);
	if (descriptor === undefined) return undefined;
	if (!Object.hasOwn(descriptor, "value")) throw new TypeError("invalid provider field");
	return descriptor.value;
}

function natural(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new TypeError("invalid provider number");
	return value;
}

function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") throw new TypeError("invalid provider flag");
	return value;
}

const encoder = new TextEncoder();
const unpairedSurrogate = /[\uD800-\uDFFF]/u;
function text(value: unknown, maxBytes: number, empty = false): string {
	if (
		typeof value !== "string" ||
		(!empty && value.length === 0) ||
		value.length > maxBytes ||
		unpairedSurrogate.test(value) ||
		encoder.encode(value).length > maxBytes
	)
		throw new TypeError("invalid provider text");
	return value;
}

function name(value: unknown, limits: DurableMessagingLimits): string {
	return parseDurableMessagingLeaseId(value, limits.nameBytes);
}

function list<T>(
	value: unknown,
	maximum: number,
	read: (item: unknown) => T,
): T[] {
	if (utilTypes.isProxy(value)) throw new ProxyProviderValue("provider proxy");
	if (!Array.isArray(value)) throw new TypeError("invalid provider list");
	const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (!Number.isSafeInteger(length) || length < 0 || length > maximum)
		throw new TypeError("invalid provider list length");
	const result: T[] = [];
	for (let index = 0; index < length; index++) {
		const entry = Object.getOwnPropertyDescriptor(value, String(index));
		if (entry === undefined || !Object.hasOwn(entry, "value"))
			throw new TypeError("invalid provider list entry");
		result.push(read(entry.value));
	}
	return result;
}

const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayLength = Object.getOwnPropertyDescriptor(
	typedArray,
	"length",
)?.get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
	typedArray,
	"buffer",
)?.get;
const typedArrayKind = Object.getOwnPropertyDescriptor(
	typedArray,
	Symbol.toStringTag,
)?.get;
const sharedBufferLength =
	typeof SharedArrayBuffer === "undefined"
		? undefined
		: Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")
				?.get;

function isSharedBuffer(value: unknown): boolean {
	if (sharedBufferLength === undefined) return false;
	try {
		sharedBufferLength.call(value);
		return true;
	} catch {
		return false;
	}
}

function message(
	value: unknown,
	limits: DurableMessagingLimits,
): DurableMessagingMessage {
	const payload = field(value, "payload");
	if (utilTypes.isProxy(payload))
		throw new ProxyProviderValue("provider proxy");
	if (
		!ArrayBuffer.isView(payload) ||
		typedArrayKind?.call(payload) !== "Uint8Array"
	)
		throw new TypeError("invalid provider payload");
	const length = typedArrayLength?.call(payload);
	const buffer = typedArrayBuffer?.call(payload);
	if (
		!Number.isSafeInteger(length) ||
		length > limits.payloadBytes ||
		isSharedBuffer(buffer)
	)
		throw new TypeError("invalid provider payload length");
	const detached = new Uint8Array(length);
	// SAFETY: the intrinsic typed-array tag above proved this is a Uint8Array.
	Uint8Array.prototype.set.call(detached, payload as Uint8Array);
	const attributes = list(
		field(value, "attributes"),
		limits.attributeCount,
		(entry) => ({
			key: text(field(entry, "key"), limits.attributeBytes),
			value: text(field(entry, "value"), limits.attributeBytes, true),
		}),
	);
	const keys = new Set<string>();
	let bytes = 0;
	for (const attribute of attributes) {
		if (keys.has(attribute.key)) throw new TypeError("duplicate attribute");
		keys.add(attribute.key);
		bytes +=
			encoder.encode(attribute.key).length +
			encoder.encode(attribute.value).length;
	}
	if (bytes > limits.attributeBytes)
		throw new TypeError("invalid provider attributes");
	return {
		id: name(field(value, "id"), limits),
		subject: name(field(value, "subject"), limits),
		payload: detached,
		attributes,
	};
}

function deadLetter(
	value: unknown,
	limits: DurableMessagingLimits,
): DurableMessagingDeadLetter {
	const source = field(value, "cause");
	const kind = field(source, "kind");
	const cause =
		kind === "lease-expired"
			? { kind: "lease-expired" as const }
			: kind === "nack"
				? {
						kind: "nack" as const,
						reason: text(field(source, "reason"), limits.reasonBytes, true),
					}
				: undefined;
	if (cause === undefined) throw new TypeError("invalid dead-letter cause");
	return {
		sourceTopic: name(field(value, "sourceTopic"), limits),
		consumerGroup: name(field(value, "consumerGroup"), limits),
		originalMessageId: name(field(value, "originalMessageId"), limits),
		originalSequence: natural(field(value, "originalSequence")),
		deliveryAttempt: natural(field(value, "deliveryAttempt")),
		cause,
	};
}

function delivery(
	value: unknown,
	limits: DurableMessagingLimits,
): DurableMessagingDelivery {
	const provenance = optional(value, "deadLetter");
	const result = {
		message: message(field(value, "message"), limits),
		sequence: natural(field(value, "sequence")),
		topic: name(field(value, "topic"), limits),
		consumerGroup: name(field(value, "consumerGroup"), limits),
		leaseId: name(field(value, "leaseId"), limits),
		leaseExpiresAtMs: natural(field(value, "leaseExpiresAtMs")),
		deliveryAttempt: natural(field(value, "deliveryAttempt")),
	};
	return provenance === undefined
		? result
		: { ...result, deadLetter: deadLetter(provenance, limits) };
}

function subscription(
	value: unknown,
	limits: DurableMessagingLimits,
): DurableMessagingSubscription {
	const startAt = field(value, "startAt");
	if (startAt !== "earliest" && startAt !== "latest")
		throw new TypeError("invalid subscription checkpoint");
	return {
		topic: name(field(value, "topic"), limits),
		consumerGroup: name(field(value, "consumerGroup"), limits),
		deadLetterTopic: name(field(value, "deadLetterTopic"), limits),
		maxDeliveryAttempts: natural(field(value, "maxDeliveryAttempts")),
		startAt,
	};
}

function event(
	value: unknown,
	limits: DurableMessagingLimits,
): DurableMessagingEvent {
	const kind = field(value, "kind");
	if (
		kind !== "topic-created" &&
		kind !== "subscription-created" &&
		kind !== "published" &&
		kind !== "leased" &&
		kind !== "acknowledged" &&
		kind !== "released" &&
		kind !== "dead-lettered" &&
		kind !== "compacted"
	)
		throw new TypeError("invalid audit event kind");
	const messageId = optional(value, "messageId");
	const consumerGroup = optional(value, "consumerGroup");
	const result: DurableMessagingEvent = {
		sequence: natural(field(value, "sequence")),
		kind,
		topic: name(field(value, "topic"), limits),
	};
	if (messageId !== undefined && consumerGroup !== undefined)
		return {
			...result,
			messageId: name(messageId, limits),
			consumerGroup: name(consumerGroup, limits),
		};
	if (messageId !== undefined)
		return { ...result, messageId: name(messageId, limits) };
	if (consumerGroup !== undefined)
		return { ...result, consumerGroup: name(consumerGroup, limits) };
	return result;
}

type Mutation =
	| "topic"
	| "subscription"
	| "publish"
	| "consume"
	| "ack"
	| "nack"
	| "compact";

function extraData(value: unknown, allowed: readonly string[]): boolean {
	const record = object(value);
	const keys = Reflect.ownKeys(record);
	if (keys.length > 32) throw new TypeError("too many provider fields");
	let extra = false;
	let disclosed = false;
	for (const key of keys) {
		if (typeof key === "string" && allowed.includes(key)) continue;
		extra = true;
		const descriptor = Object.getOwnPropertyDescriptor(record, key);
		if (
			descriptor !== undefined &&
			Object.hasOwn(descriptor, "value") &&
			descriptor.value !== undefined &&
			descriptor.value !== null
		)
			disclosed = true;
	}
	if (disclosed) return true;
	if (extra) throw new TypeError("unexpected provider fields");
	return false;
}

function observedData(value: unknown): boolean {
	if (value === null || value === undefined) return false;
	if (utilTypes.isProxy(value)) throw new ProxyProviderValue("provider proxy");
	if (typeof value !== "object") return true;
	const keys = Reflect.ownKeys(value);
	if (keys.length > 32) throw new TypeError("too many provider fields");
	for (const key of keys) {
		if (Array.isArray(value) && key === "length") continue;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (
			descriptor !== undefined &&
			Object.hasOwn(descriptor, "value") &&
			descriptor.value !== undefined &&
			descriptor.value !== null
		)
			return true;
	}
	return false;
}

function disclosure<T>(): DurableMessagingOutcome<T> {
	// oxlint-disable-next-line anti-slop/no-known-value-widening -- SAFETY: the sentinel deliberately represents malformed boundary data.
	const evidence: unknown = { status: "unknown", value: true };
	// SAFETY: the caller only uses this malformed sentinel to report disclosure or uncertainty.
	// oxlint-disable-next-line anti-slop/no-widen-then-assert -- SAFETY: the sentinel is intentionally not a valid outcome.
	return evidence as DurableMessagingOutcome<T>;
}

function exactRecord(value: unknown, keys: readonly string[]): object {
	const record = object(value);
	const prototype = Object.getPrototypeOf(record);
	if (prototype !== Object.prototype && prototype !== null)
		throw new TypeError("invalid uncertainty prototype");
	const actual = Reflect.ownKeys(record);
	if (
		actual.length !== keys.length ||
		actual.some((key) => typeof key !== "string" || !keys.includes(key))
	)
		throw new TypeError("invalid uncertainty fields");
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(record, key);
		if (
			descriptor === undefined ||
			!Object.hasOwn(descriptor, "value") ||
			!descriptor.enumerable
		)
			throw new TypeError("invalid uncertainty field");
	}
	return record;
}

function uncertain<T>(
	value: DurableMessagingOutcome<T>,
	status: "unknown" | "expired",
): DurableMessagingOutcome<T> {
	const top = object(value);
	if (extraData(top, ["status", "operation"])) return disclosure();
	const originalOperation = field(top, "operation");
	if (extraData(originalOperation, ["id", "expiresAtMs"])) return disclosure();
	exactRecord(top, ["status", "operation"]);
	exactRecord(originalOperation, ["id", "expiresAtMs"]);
	const operation = parseDurableMessagingOperation(originalOperation);
	return { status, operation };
}

function committed(
	kind: Mutation,
	value: unknown,
	limits: DurableMessagingLimits,
) {
	if (kind === "topic") return { topic: name(field(value, "topic"), limits) };
	if (kind === "subscription")
		return {
			subscription: subscription(field(value, "subscription"), limits),
			firstAvailableSequence: natural(field(value, "firstAvailableSequence")),
			historyTruncated: boolean(field(value, "historyTruncated")),
		};
	if (kind === "consume")
		return list(value, limits.batchSize, (item) => delivery(item, limits));
	if (kind === "compact")
		return {
			topic: name(field(value, "topic"), limits),
			firstAvailableSequence: natural(field(value, "firstAvailableSequence")),
			removedMessages: natural(field(value, "removedMessages")),
		};
	const receipt = {
		messageId: name(field(value, "messageId"), limits),
		sequence: natural(field(value, "sequence")),
	};
	if (kind === "publish" || kind === "ack") return receipt;
	const disposition = field(value, "disposition");
	if (disposition === "released") return { ...receipt, disposition };
	if (disposition === "dead-lettered")
		return {
			...receipt,
			disposition,
			deadLetterMessageId: name(field(value, "deadLetterMessageId"), limits),
			deadLetterSequence: natural(field(value, "deadLetterSequence")),
		};
	throw new TypeError("invalid nack receipt");
}

function rejection(value: unknown) {
	const codes = [
		"invalid-argument",
		"unauthorized",
		"not-found",
		"unsupported",
		"operation-conflict",
		"message-conflict",
		"subscription-conflict",
		"retention-blocked",
		"lease-lost",
		"capacity-exceeded",
		"unavailable",
	] as const;
	const code = codes.find((candidate) => candidate === value);
	if (code === undefined) throw new TypeError("invalid provider rejection");
	return code;
}

export function snapshotMutation<T>(
	kind: Mutation,
	value: DurableMessagingOutcome<T>,
	limits: DurableMessagingLimits,
): DurableMessagingOutcome<T> {
	const record = object(value);
	let status: unknown;
	try {
		status = field(record, "status");
	} catch (error) {
		if (extraData(record, ["status"])) return disclosure();
		throw error;
	}
	if (status === "unknown" || status === "expired")
		return uncertain(value, status);
	if (status === "rejected") {
		if (extraData(record, ["status", "code"])) return disclosure();
		return { status, code: rejection(field(value, "code")) };
	}
	if (status !== "committed") {
		if (extraData(record, ["status"])) return disclosure();
		throw new TypeError("invalid provider outcome");
	}
	if (extraData(record, ["status", "value"])) return disclosure();
	const original = field(value, "value");
	let snapshot: ReturnType<typeof committed>;
	try {
		snapshot = committed(kind, original, limits);
	} catch (error) {
		if (error instanceof ProxyProviderValue) throw error;
		if (observedData(original)) return disclosure();
		throw error;
	}
	// SAFETY: `kind` selects the parser corresponding to the invoked provider method.
	return {
		status,
		value: snapshot,
	} as DurableMessagingOutcome<T>;
}

export function snapshotAudit(
	value: Awaited<ReturnType<DurableMessaging["events"]>>,
	limits: DurableMessagingLimits,
): Awaited<ReturnType<DurableMessaging["events"]>> {
	const status = field(value, "status");
	if (status === "gap")
		return {
			status,
			firstAvailableSequence: natural(field(value, "firstAvailableSequence")),
			latestSequence: natural(field(value, "latestSequence")),
		};
	if (status === "ok")
		return {
			status,
			events: list(field(value, "events"), limits.eventPageSize, (item) =>
				event(item, limits),
			),
			firstAvailableSequence: natural(field(value, "firstAvailableSequence")),
			nextAfterSequence: natural(field(value, "nextAfterSequence")),
			hasMore: boolean(field(value, "hasMore")),
		};
	if (status === "rejected") {
		return { status, code: rejection(field(value, "code")) };
	}
	throw new TypeError("invalid audit outcome");
}

export function snapshotLimits(
	value: DurableMessagingLimits,
): DurableMessagingLimits {
	const limit = (key: keyof DurableMessagingLimits) => {
		const current = field(value, key);
		if (
			current === null ||
			(typeof current !== "number" &&
				typeof current !== "object" &&
				typeof current !== "function")
		)
			throw new InvalidProviderLimit(key);
		if (
			typeof current === "number" &&
			(!Number.isSafeInteger(current) ||
				current <= 0 ||
				current > DURABLE_MESSAGING_LIMITS[key])
		)
			throw new InvalidProviderLimit(key);
		return natural(current);
	};
	const result = {
		nameBytes: limit("nameBytes"),
		reasonBytes: limit("reasonBytes"),
		payloadBytes: limit("payloadBytes"),
		attributeCount: limit("attributeCount"),
		attributeBytes: limit("attributeBytes"),
		batchSize: limit("batchSize"),
		leaseMs: limit("leaseMs"),
		operationWindowMs: limit("operationWindowMs"),
		deliveryAttempts: limit("deliveryAttempts"),
		retainedMessages: limit("retainedMessages"),
		retainedReceipts: limit("retainedReceipts"),
		retainedEvents: limit("retainedEvents"),
		topics: limit("topics"),
		subscriptions: limit("subscriptions"),
		eventPageSize: limit("eventPageSize"),
	};
	return Object.freeze(result);
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof */
