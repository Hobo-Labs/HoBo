import { performance } from "node:perf_hooks";
import { types } from "node:util";
import {
	DURABLE_MESSAGING_LIMITS,
	DURABLE_MESSAGING_WIT_INTERFACE,
	type DurableMessaging,
	type DurableMessagingEvent,
	type DurableMessagingLimits,
	type DurableMessagingMessage,
	type DurableMessagingOperation,
	type DurableMessagingRejectionCode,
	type DurableMessagingSubscription,
	parseDurableMessagingOperation,
} from "@hobo/core";
import type * as Wit from "@hobo/wit/durable-messaging";
import { synchronousResult } from "./synchronous-result.js";

const intrinsicApply = Reflect.apply;
const intrinsicWeakGet = WeakMap.prototype.get;
const intrinsicWeakSet = WeakMap.prototype.set;

function readPrivate<V>(table: WeakMap<object, V>, key: object): V | undefined {
	// SAFETY: the private table determines the value type for this key.
	return intrinsicApply(intrinsicWeakGet, table, [key]) as V | undefined;
}
function writePrivate<V>(
	table: WeakMap<object, V>,
	key: object,
	value: V,
): void {
	intrinsicApply(intrinsicWeakSet, table, [key, value]);
}
const intrinsicBind = Function.prototype.bind;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsicByteLength = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"byteLength",
)?.get;
const intrinsicBuffer = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"buffer",
)?.get;
const intrinsicUint8Set = Uint8Array.prototype.set;

export type DurableMessagingWitHost = Pick<
	typeof Wit,
	| "limits"
	| "ensureTopic"
	| "ensureSubscription"
	| "publish"
	| "consume"
	| "ack"
	| "nack"
	| "compact"
	| "events"
>;

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- SAFETY: this host boundary validates each untrusted value before it can enter a port or component. */
const invalid = (): never => {
	throw new TypeError("durable_messaging.invalid_boundary_value");
};

function record(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	if (
		typeof value !== "object" ||
		value === null ||
		types.isProxy(value) ||
		Array.isArray(value)
	)
		return invalid();
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return invalid();
	const keys = Reflect.ownKeys(value);
	if (
		keys.length > required.length + optional.length ||
		keys.some(
			(key) =>
				typeof key !== "string" || ![...required, ...optional].includes(key),
		)
	)
		return invalid();
	const properties = Object.getOwnPropertyDescriptors(value);
	const copy: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		if (typeof key !== "string") return invalid();
		const descriptor = properties[key];
		if (
			descriptor === undefined ||
			!Object.hasOwn(descriptor, "value") ||
			!descriptor.enumerable
		)
			return invalid();
		copy[key] = descriptor.value;
	}
	if (required.some((key) => !Object.hasOwn(copy, key))) return invalid();
	return copy;
}

function array(value: unknown, max: number): unknown[] {
	if (types.isProxy(value) || !Array.isArray(value)) return invalid();
	const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (!Number.isSafeInteger(length) || length < 0 || length > max)
		return invalid();
	const keys = Reflect.ownKeys(value);
	if (keys.length !== length + 1) return invalid();
	const result: unknown[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (
			descriptor === undefined ||
			!Object.hasOwn(descriptor, "value") ||
			!descriptor.enumerable
		)
			return invalid();
		result.push(descriptor.value);
	}
	return result;
}

function text(
	value: unknown,
	max: number,
	empty = false,
	controls = false,
): string {
	if (
		typeof value !== "string" ||
		(!empty && value.length === 0) ||
		value.length > max ||
		/[\p{Cs}]/u.test(value) ||
		(!controls && /[\p{Cc}]/u.test(value)) ||
		Buffer.byteLength(value, "utf8") > max
	)
		return invalid();
	return value;
}

function integer(
	value: unknown,
	max = Number.MAX_SAFE_INTEGER,
	min = 0,
): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < min ||
		value > max
	)
		return invalid();
	return value;
}

function fromU64(
	value: unknown,
	max = Number.MAX_SAFE_INTEGER,
	min = 0,
): number {
	if (typeof value !== "bigint" || value < BigInt(min) || value > BigInt(max))
		return invalid();
	return Number(value);
}

function bytes(value: unknown, max: number): Uint8Array {
	if (types.isProxy(value) || !types.isUint8Array(value)) return invalid();
	if (intrinsicByteLength === undefined || intrinsicBuffer === undefined)
		return invalid();
	const length: unknown = intrinsicApply(intrinsicByteLength, value, []);
	const buffer: unknown = intrinsicApply(intrinsicBuffer, value, []);
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < 0 ||
		length > max ||
		types.isSharedArrayBuffer(buffer)
	)
		return invalid();
	const valuePrototype = Object.getPrototypeOf(value);
	if (
		valuePrototype !== Uint8Array.prototype &&
		valuePrototype !== Buffer.prototype
	)
		return invalid();
	if (Reflect.ownKeys(value).length !== length) return invalid();
	const copy = new Uint8Array(length);
	intrinsicApply(intrinsicUint8Set, copy, [value]);
	return copy;
}

function operation(value: unknown): DurableMessagingOperation {
	const input = record(value, ["id", "expiresAtMs"]);
	return parseDurableMessagingOperation({
		id: input.id,
		expiresAtMs: fromU64(input.expiresAtMs),
	});
}

function requestOperation(value: unknown): DurableMessagingOperation {
	if (
		typeof value !== "object" ||
		value === null ||
		types.isProxy(value) ||
		Array.isArray(value)
	)
		return invalid();
	const field = Object.getOwnPropertyDescriptor(value, "operation");
	if (
		field === undefined ||
		!Object.hasOwn(field, "value") ||
		!field.enumerable
	)
		return invalid();
	return operation(field.value);
}

async function mutation<T>(
	value: unknown,
	run: (op: DurableMessagingOperation) => Promise<WitOutcome<T>>,
	metadataCurrent: () => boolean,
): Promise<WitOutcome<T>> {
	const op = requestOperation(value);
	try {
		const result = await run(op);
		if (!metadataCurrent()) return invalid();
		return result;
	} catch {
		return { tag: "unknown", val: witOperation(op) };
	}
}

function providerOperation(value: unknown): DurableMessagingOperation {
	const input = record(value, ["id", "expiresAtMs"]);
	return parseDurableMessagingOperation({
		id: input.id,
		expiresAtMs: integer(input.expiresAtMs),
	});
}

const witOperation = (value: DurableMessagingOperation): Wit.Operation => ({
	id: value.id,
	expiresAtMs: BigInt(value.expiresAtMs),
});

function limits(value: unknown): DurableMessagingLimits {
	const input = record(value, [
		"nameBytes",
		"reasonBytes",
		"payloadBytes",
		"attributeCount",
		"attributeBytes",
		"batchSize",
		"leaseMs",
		"operationWindowMs",
		"deliveryAttempts",
		"retainedMessages",
		"retainedReceipts",
		"retainedEvents",
		"topics",
		"subscriptions",
		"eventPageSize",
	]);
	return Object.freeze({
		nameBytes: integer(input.nameBytes, DURABLE_MESSAGING_LIMITS.nameBytes, 1),
		reasonBytes: integer(
			input.reasonBytes,
			DURABLE_MESSAGING_LIMITS.reasonBytes,
			1,
		),
		payloadBytes: integer(
			input.payloadBytes,
			DURABLE_MESSAGING_LIMITS.payloadBytes,
			1,
		),
		attributeCount: integer(
			input.attributeCount,
			DURABLE_MESSAGING_LIMITS.attributeCount,
			1,
		),
		attributeBytes: integer(
			input.attributeBytes,
			DURABLE_MESSAGING_LIMITS.attributeBytes,
			1,
		),
		batchSize: integer(input.batchSize, DURABLE_MESSAGING_LIMITS.batchSize, 1),
		leaseMs: integer(input.leaseMs, DURABLE_MESSAGING_LIMITS.leaseMs, 1),
		operationWindowMs: integer(
			input.operationWindowMs,
			DURABLE_MESSAGING_LIMITS.operationWindowMs,
			1,
		),
		deliveryAttempts: integer(
			input.deliveryAttempts,
			DURABLE_MESSAGING_LIMITS.deliveryAttempts,
			1,
		),
		retainedMessages: integer(
			input.retainedMessages,
			DURABLE_MESSAGING_LIMITS.retainedMessages,
			1,
		),
		retainedReceipts: integer(
			input.retainedReceipts,
			DURABLE_MESSAGING_LIMITS.retainedReceipts,
			1,
		),
		retainedEvents: integer(
			input.retainedEvents,
			DURABLE_MESSAGING_LIMITS.retainedEvents,
			1,
		),
		topics: integer(input.topics, DURABLE_MESSAGING_LIMITS.topics, 1),
		subscriptions: integer(
			input.subscriptions,
			DURABLE_MESSAGING_LIMITS.subscriptions,
			1,
		),
		eventPageSize: integer(
			input.eventPageSize,
			DURABLE_MESSAGING_LIMITS.eventPageSize,
			1,
		),
	});
}

function subscription(
	value: unknown,
	bounds: DurableMessagingLimits,
): DurableMessagingSubscription {
	const data = record(value, [
		"topic",
		"consumerGroup",
		"deadLetterTopic",
		"maxDeliveryAttempts",
		"startAt",
	]);
	const topic = text(data.topic, bounds.nameBytes);
	const deadLetterTopic = text(data.deadLetterTopic, bounds.nameBytes);
	if (
		topic === deadLetterTopic ||
		(data.startAt !== "earliest" && data.startAt !== "latest")
	)
		return invalid();
	return Object.freeze({
		topic,
		consumerGroup: text(data.consumerGroup, bounds.nameBytes),
		deadLetterTopic,
		maxDeliveryAttempts: integer(
			data.maxDeliveryAttempts,
			bounds.deliveryAttempts,
			1,
		),
		startAt: data.startAt,
	});
}

function message(
	value: unknown,
	bounds: DurableMessagingLimits,
): DurableMessagingMessage {
	const data = record(value, ["id", "subject", "payload", "attributes"]);
	const seen = new Set<string>();
	let total = 0;
	const attributes = array(data.attributes, bounds.attributeCount).map(
		(entry) => {
			const item = record(entry, ["key", "value"]);
			const key = text(item.key, bounds.attributeBytes, false, true);
			const val = text(item.value, bounds.attributeBytes, true, true);
			if (seen.has(key)) return invalid();
			seen.add(key);
			total += Buffer.byteLength(key, "utf8") + Buffer.byteLength(val, "utf8");
			if (total > bounds.attributeBytes) return invalid();
			return Object.freeze({ key, value: val });
		},
	);
	return Object.freeze({
		id: text(data.id, bounds.nameBytes),
		subject: text(data.subject, bounds.nameBytes),
		payload: bytes(data.payload, bounds.payloadBytes),
		attributes: Object.freeze(attributes),
	});
}

function witMessage(
	value: unknown,
	bounds: DurableMessagingLimits,
): Wit.Message {
	const captured = message(value, bounds);
	return { ...captured, attributes: [...captured.attributes] };
}

const rejectionCodes: readonly DurableMessagingRejectionCode[] = [
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
];
function rejection(value: unknown): DurableMessagingRejectionCode {
	if (typeof value !== "string") return invalid();
	for (const code of rejectionCodes) if (code === value) return code;
	return invalid();
}

type WitOutcome<T> =
	| { tag: "committed"; val: T }
	| { tag: "rejected"; val: Wit.RejectionCode }
	| { tag: "unknown"; val: Wit.Operation }
	| { tag: "expired"; val: Wit.Operation };

async function outcome<T>(
	op: DurableMessagingOperation,
	run: () => Promise<unknown>,
	committed: (value: unknown) => T,
	metadataCurrent: () => boolean,
): Promise<WitOutcome<T>> {
	try {
		const value = await run();
		if (!metadataCurrent()) return invalid();
		const base = record(value, ["status"], ["value", "code", "operation"]);
		if (base.status === "committed") {
			const result = record(value, ["status", "value"]);
			return { tag: "committed", val: committed(result.value) };
		}
		if (base.status === "rejected") {
			const result = record(value, ["status", "code"]);
			return { tag: "rejected", val: rejection(result.code) };
		}
		if (base.status === "unknown" || base.status === "expired") {
			const result = record(value, ["status", "operation"]);
			const echoed = providerOperation(result.operation);
			if (echoed.id !== op.id || echoed.expiresAtMs !== op.expiresAtMs)
				return invalid();
			return { tag: base.status, val: witOperation(op) };
		}
		return invalid();
	} catch {
		return { tag: "unknown", val: witOperation(op) };
	}
}

function deadLetter(
	value: unknown,
	bounds: DurableMessagingLimits,
): Wit.DeadLetter {
	const data = record(value, [
		"sourceTopic",
		"consumerGroup",
		"originalMessageId",
		"originalSequence",
		"deliveryAttempt",
		"cause",
	]);
	const cause = record(data.cause, ["kind"], ["reason"]);
	let converted: Wit.DeadLetterCause;
	if (cause.kind === "lease-expired") {
		record(data.cause, ["kind"]);
		converted = { tag: "lease-expired" };
	} else if (cause.kind === "nack") {
		const explicit = record(data.cause, ["kind", "reason"]);
		converted = {
			tag: "nack",
			val: text(explicit.reason, bounds.reasonBytes, true, true),
		};
	} else return invalid();
	return {
		sourceTopic: text(data.sourceTopic, bounds.nameBytes),
		consumerGroup: text(data.consumerGroup, bounds.nameBytes),
		originalMessageId: text(data.originalMessageId, bounds.nameBytes),
		originalSequence: BigInt(
			integer(data.originalSequence, Number.MAX_SAFE_INTEGER, 1),
		),
		deliveryAttempt: integer(data.deliveryAttempt, bounds.deliveryAttempts, 1),
		cause: converted,
	};
}

function deliveries(
	value: unknown,
	topic: string,
	consumerGroup: string,
	maximum: number,
	bounds: DurableMessagingLimits,
): Wit.Delivery[] {
	const ids = new Set<string>();
	const sequences = new Set<number>();
	const leases = new Set<string>();
	return array(value, maximum).map((item) => {
		const data = record(
			item,
			[
				"message",
				"sequence",
				"topic",
				"consumerGroup",
				"leaseId",
				"leaseExpiresAtMs",
				"deliveryAttempt",
			],
			["deadLetter"],
		);
		const msg = witMessage(data.message, bounds);
		const sequence = integer(data.sequence, Number.MAX_SAFE_INTEGER, 1);
		const leaseId = text(data.leaseId, bounds.nameBytes);
		if (
			data.topic !== topic ||
			data.consumerGroup !== consumerGroup ||
			ids.has(msg.id) ||
			sequences.has(sequence) ||
			leases.has(leaseId)
		)
			return invalid();
		ids.add(msg.id);
		sequences.add(sequence);
		leases.add(leaseId);
		const origin =
			data.deadLetter === undefined
				? undefined
				: deadLetter(data.deadLetter, bounds);
		if (origin?.sourceTopic === topic) return invalid();
		const result: Wit.Delivery = {
			message: msg,
			sequence: BigInt(sequence),
			topic,
			consumerGroup,
			leaseId,
			leaseExpiresAtMs: BigInt(
				integer(data.leaseExpiresAtMs, Number.MAX_SAFE_INTEGER, 1),
			),
			deliveryAttempt: integer(
				data.deliveryAttempt,
				bounds.deliveryAttempts,
				1,
			),
		};
		if (origin !== undefined) result.deadLetter = origin;
		return result;
	});
}

function event(value: unknown, bounds: DurableMessagingLimits): Wit.Event {
	const item = record(
		value,
		["sequence", "kind", "topic"],
		["messageId", "consumerGroup"],
	);
	const kinds: readonly DurableMessagingEvent["kind"][] = [
		"topic-created",
		"subscription-created",
		"published",
		"leased",
		"acknowledged",
		"released",
		"dead-lettered",
		"compacted",
	];
	const kind = kinds.find((candidate) => candidate === item.kind);
	if (kind === undefined) return invalid();
	const converted: Wit.Event = {
		sequence: BigInt(integer(item.sequence, Number.MAX_SAFE_INTEGER, 1)),
		kind,
		topic: text(item.topic, bounds.nameBytes),
	};
	if (item.messageId !== undefined)
		converted.messageId = text(item.messageId, bounds.nameBytes);
	if (item.consumerGroup !== undefined)
		converted.consumerGroup = text(item.consumerGroup, bounds.nameBytes);
	return converted;
}

function eventsResult(
	value: unknown,
	after: number,
	maximum: number,
	bounds: DurableMessagingLimits,
): Wit.EventOutcome {
	const result = record(
		value,
		["status"],
		[
			"events",
			"firstAvailableSequence",
			"nextAfterSequence",
			"hasMore",
			"latestSequence",
			"code",
		],
	);
	if (result.status === "rejected") {
		const data = record(value, ["status", "code"]);
		return { tag: "rejected", val: rejection(data.code) };
	}
	if (result.status === "gap") {
		const data = record(value, [
			"status",
			"firstAvailableSequence",
			"latestSequence",
		]);
		const first = integer(
			data.firstAvailableSequence,
			Number.MAX_SAFE_INTEGER,
			1,
		);
		const latest = integer(data.latestSequence);
		if (after >= first - 1 || latest < first - 1) return invalid();
		return {
			tag: "gap",
			val: {
				firstAvailableSequence: BigInt(first),
				latestSequence: BigInt(latest),
			},
		};
	}
	if (result.status !== "ok") return invalid();
	const data = record(value, [
		"status",
		"events",
		"firstAvailableSequence",
		"nextAfterSequence",
		"hasMore",
	]);
	const first = integer(
		data.firstAvailableSequence,
		Number.MAX_SAFE_INTEGER,
		1,
	);
	const next = integer(data.nextAfterSequence);
	if (typeof data.hasMore !== "boolean" || after < first - 1) return invalid();
	const entries = array(data.events, maximum).map((entry) =>
		event(entry, bounds),
	);
	for (let index = 0; index < entries.length; index++) {
		if (entries[index]?.sequence !== BigInt(after) + BigInt(index) + 1n)
			return invalid();
	}
	if (next !== after + entries.length || (entries.length === 0 && data.hasMore))
		return invalid();
	return {
		tag: "ok",
		val: {
			events: entries,
			firstAvailableSequence: BigInt(first),
			nextAfterSequence: BigInt(next),
			hasMore: data.hasMore,
		},
	};
}

function portField(
	port: DurableMessaging,
	key: keyof DurableMessaging,
): unknown {
	let current: object | null = port;
	for (
		let depth = 0;
		current !== null && current !== Object.prototype && depth < 8;
		depth++
	) {
		if (types.isProxy(current)) return invalid();
		const descriptor = Object.getOwnPropertyDescriptor(current, key);
		if (descriptor !== undefined) {
			if (!Object.hasOwn(descriptor, "value")) return invalid();
			return descriptor.value;
		}
		current = Object.getPrototypeOf(current);
	}
	return invalid();
}

type PortMethod = Exclude<keyof DurableMessaging, "limits">;
function portMethod<K extends PortMethod>(
	port: DurableMessaging,
	key: K,
): DurableMessaging[K] {
	const value = portField(port, key);
	if (typeof value !== "function" || types.isProxy(value)) return invalid();
	// SAFETY: key names a port method and the host supplied a concrete data function; binding retains the receiver.
	return intrinsicApply(intrinsicBind, value, [port]) as DurableMessaging[K];
}

export interface DurableMessagingAuthorization {
	readonly phase: "dispatch" | "disclose";
	readonly method: PortMethod;
	readonly scope:
		| "instance"
		| "topic"
		| "consumer-group"
		| "consumer-group-and-dead-letter";
	readonly topic?: string;
	readonly consumerGroup?: string;
	readonly operation?: DurableMessagingOperation;
	readonly messageId?: string;
	readonly sequence?: number;
	readonly leaseId?: string;
	readonly maxMessages?: number;
	readonly visibilityTimeoutMs?: number;
	readonly throughSequence?: number;
	readonly deadLetterTopic?: string;
	readonly maxDeliveryAttempts?: number;
	readonly startAt?: "earliest" | "latest";
	readonly reason?: string;
}

export interface DurableMessagingLimitsGrant {
	readonly revoke: () => void;
}
const limitsGrants = new WeakMap<object, { active: boolean }>();
export function createDurableMessagingLimitsGrant(): DurableMessagingLimitsGrant {
	const state = { active: true };
	const grant = Object.freeze({
		revoke: () => {
			state.active = false;
		},
	});
	writePrivate(limitsGrants, grant, state);
	return grant;
}

export interface DurableMessagingPortMetadataClaim {
	readonly port: DurableMessaging;
	readonly limits: DurableMessagingLimits;
}
export interface DurableMessagingPortMetadataGrant {
	readonly revoke: () => void;
}
interface PortMetadataState {
	active: boolean;
	readonly claim: DurableMessagingPortMetadataClaim;
	readonly verify: (claim: DurableMessagingPortMetadataClaim) => boolean;
}
const portMetadataGrants = new WeakMap<object, PortMetadataState>();
export function createDurableMessagingPortMetadataGrant(input: {
	readonly port: DurableMessaging;
	readonly limits: DurableMessagingLimits;
	readonly verify: (claim: DurableMessagingPortMetadataClaim) => boolean;
}): DurableMessagingPortMetadataGrant {
	const data = record(input, ["port", "limits", "verify"]);
	if (
		typeof data.port !== "object" ||
		data.port === null ||
		types.isProxy(data.port) ||
		typeof data.verify !== "function" ||
		types.isProxy(data.verify)
	)
		return invalid();
	// SAFETY: this value is an opaque identity; methods are validated when the host binds it.
	const port = data.port as DurableMessaging;
	// SAFETY: the trusted host supplies a synchronous data function checked above.
	const verify = data.verify as PortMetadataState["verify"];
	const claim = Object.freeze({ port, limits: limits(data.limits) });
	const state: PortMetadataState = { active: true, claim, verify };
	if (!portMetadataVerified(state)) return invalid();
	const grant = Object.freeze({
		revoke: () => {
			state.active = false;
		},
	});
	writePrivate(portMetadataGrants, grant, state);
	return grant;
}
function portMetadataVerified(state: PortMetadataState): boolean {
	try {
		if (!state.active) return false;
		const result: unknown = intrinsicApply(state.verify, undefined, [
			state.claim,
		]);
		return synchronousResult(result) === true && state.active;
	} catch {
		return false;
	}
}

export interface DurableMessagingLifecycle {
	readonly kind: "durable-messaging-lifecycle";
}
interface LifecycleState {
	active: number;
	readonly maxInFlight: number;
	startPending: boolean;
	startDeadline: number;
	unresolved: boolean;
}
const lifecycles = new WeakMap<object, LifecycleState>();
const hostLifecycles = new WeakMap<object, LifecycleState>();
const privateLimit = Symbol("private-limit");
export function createDurableMessagingLifecycle(
	options: { readonly maxInFlight?: number } = {},
): DurableMessagingLifecycle {
	const config = record(options, [], ["maxInFlight"]);
	const maxInFlight =
		config.maxInFlight === undefined
			? 128
			: integer(config.maxInFlight, 128, 1);
	const lifecycle = Object.freeze({
		kind: "durable-messaging-lifecycle" as const,
	});
	writePrivate(lifecycles, lifecycle, {
		active: 0,
		maxInFlight,
		startPending: false,
		startDeadline: 0,
		unresolved: false,
	});
	return lifecycle;
}

export interface DurableMessagingWitHostOptions {
	readonly limitsGrant: DurableMessagingLimitsGrant;
	readonly lifecycle: DurableMessagingLifecycle;
	readonly portMetadataGrant?: DurableMessagingPortMetadataGrant;
	readonly authorize: (
		request: DurableMessagingAuthorization,
	) => boolean | Promise<boolean>;
	readonly timeoutMs?: number;
}

export function createDurableMessagingWitHost(
	port: DurableMessaging,
	options: DurableMessagingWitHostOptions,
): DurableMessagingWitHost {
	const config = record(
		options,
		["authorize", "limitsGrant", "lifecycle"],
		["timeoutMs", "portMetadataGrant"],
	);
	if (
		typeof config.authorize !== "function" ||
		types.isProxy(config.authorize) ||
		typeof config.limitsGrant !== "object" ||
		config.limitsGrant === null ||
		types.isProxy(config.limitsGrant) ||
		typeof config.lifecycle !== "object" ||
		config.lifecycle === null ||
		types.isProxy(config.lifecycle)
	)
		return invalid();
	const grant = readPrivate(limitsGrants, config.limitsGrant);
	const lifecycle = readPrivate(lifecycles, config.lifecycle);
	if (grant === undefined || lifecycle === undefined) return invalid();
	// SAFETY: the required host capability is a data function; it is invoked with frozen, validated scope facts.
	const authorize =
		config.authorize as DurableMessagingWitHostOptions["authorize"];
	const timeoutMs =
		config.timeoutMs === undefined
			? 30_000
			: integer(config.timeoutMs, 300_000, 1);
	if (typeof port !== "object" || port === null || types.isProxy(port))
		return invalid();
	let metadata: PortMetadataState | undefined;
	if (config.portMetadataGrant !== undefined) {
		if (
			typeof config.portMetadataGrant !== "object" ||
			config.portMetadataGrant === null ||
			types.isProxy(config.portMetadataGrant)
		)
			return invalid();
		metadata = readPrivate(portMetadataGrants, config.portMetadataGrant);
		if (
			metadata === undefined ||
			metadata.claim.port !== port ||
			!portMetadataVerified(metadata)
		)
			return invalid();
	}
	const bounds =
		metadata === undefined
			? limits(portField(port, "limits"))
			: metadata.claim.limits;
	const metadataCurrent = () =>
		metadata === undefined || portMetadataVerified(metadata);
	const guardedOutcome = <T>(
		op: DurableMessagingOperation,
		run: () => Promise<unknown>,
		committed: (value: unknown) => T,
	) => outcome(op, run, committed, metadataCurrent);
	const guardedMutation = <T>(
		value: unknown,
		run: (op: DurableMessagingOperation) => Promise<WitOutcome<T>>,
	) => mutation(value, run, metadataCurrent);
	const bounded = <T>(
		run: (alive: () => boolean) => Promise<T>,
	): Promise<T> => {
		if (lifecycle.unresolved || lifecycle.active >= lifecycle.maxInFlight)
			return Promise.reject(new Error("durable_messaging.host_capacity"));
		lifecycle.active++;
		const deadline = performance.now() + timeoutMs;
		let expired = false;
		const alive = () =>
			!expired &&
			!lifecycle.unresolved &&
			(!lifecycle.startPending ||
				performance.now() < lifecycle.startDeadline) &&
			performance.now() < deadline;
		const work = Promise.resolve()
			.then(() => {
				if (!alive()) throw new Error("durable_messaging.host_timeout");
				return run(alive);
			})
			.finally(() => {
				lifecycle.active--;
			});
		const inTime = work.then((value) => {
			if (!alive()) throw new Error("durable_messaging.host_timeout");
			return value;
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				expired = true;
				reject(new Error("durable_messaging.host_timeout"));
			}, timeoutMs);
		});
		return Promise.race([inTime, timeout]).finally(() => {
			if (timer !== undefined) clearTimeout(timer);
		});
	};
	const original = {
		ensureTopic: portMethod(port, "ensureTopic"),
		ensureSubscription: portMethod(port, "ensureSubscription"),
		publish: portMethod(port, "publish"),
		consume: portMethod(port, "consume"),
		ack: portMethod(port, "ack"),
		nack: portMethod(port, "nack"),
		compact: portMethod(port, "compact"),
		events: portMethod(port, "events"),
	};
	const guarded = <T>(
		scope: Omit<DurableMessagingAuthorization, "phase">,
		run: () => Promise<T>,
	): Promise<T> =>
		bounded(async (alive) => {
			const request = Object.freeze({ ...scope, phase: "dispatch" as const });
			if (
				!metadataCurrent() ||
				(await authorize(request)) !== true ||
				!alive() ||
				!metadataCurrent()
			)
				throw new Error("durable_messaging.unauthorized");
			const value = await run();
			if (!alive() || !metadataCurrent())
				throw new Error("durable_messaging.host_timeout");
			const disclosure = Object.freeze({
				...scope,
				phase: "disclose" as const,
			});
			if (
				(await authorize(disclosure)) !== true ||
				!alive() ||
				!metadataCurrent()
			)
				throw new Error("durable_messaging.unauthorized");
			return value;
		});
	const calls = {
		ensureTopic: (input: Parameters<DurableMessaging["ensureTopic"]>[0]) =>
			guarded(
				{
					method: "ensureTopic",
					scope: "topic",
					topic: input.topic,
					operation: input.operation,
				},
				() => original.ensureTopic(input),
			),
		ensureSubscription: (
			input: Parameters<DurableMessaging["ensureSubscription"]>[0],
		) =>
			guarded(
				{
					method: "ensureSubscription",
					scope: "consumer-group-and-dead-letter",
					topic: input.subscription.topic,
					consumerGroup: input.subscription.consumerGroup,
					operation: input.operation,
					deadLetterTopic: input.subscription.deadLetterTopic,
					maxDeliveryAttempts: input.subscription.maxDeliveryAttempts,
					startAt: input.subscription.startAt,
				},
				() => original.ensureSubscription(input),
			),
		publish: (input: Parameters<DurableMessaging["publish"]>[0]) =>
			guarded(
				{
					method: "publish",
					scope: "topic",
					topic: input.topic,
					operation: input.operation,
					messageId: input.message.id,
				},
				() => original.publish(input),
			),
		consume: (input: Parameters<DurableMessaging["consume"]>[0]) =>
			guarded(
				{
					method: "consume",
					scope: "consumer-group-and-dead-letter",
					topic: input.topic,
					consumerGroup: input.consumerGroup,
					operation: input.operation,
					maxMessages: input.maxMessages,
					visibilityTimeoutMs: input.visibilityTimeoutMs,
				},
				() => original.consume(input),
			),
		ack: (input: Parameters<DurableMessaging["ack"]>[0]) =>
			guarded(
				{
					method: "ack",
					scope: "consumer-group",
					topic: input.topic,
					consumerGroup: input.consumerGroup,
					operation: input.operation,
					messageId: input.messageId,
					sequence: input.sequence,
					leaseId: input.leaseId,
				},
				() => original.ack(input),
			),
		nack: (input: Parameters<DurableMessaging["nack"]>[0]) =>
			guarded(
				{
					method: "nack",
					scope: "consumer-group-and-dead-letter",
					topic: input.topic,
					consumerGroup: input.consumerGroup,
					operation: input.operation,
					messageId: input.messageId,
					sequence: input.sequence,
					leaseId: input.leaseId,
					reason: input.reason,
				},
				() => original.nack(input),
			),
		compact: (input: Parameters<DurableMessaging["compact"]>[0]) =>
			guarded(
				{
					method: "compact",
					scope: "topic",
					topic: input.topic,
					operation: input.operation,
					throughSequence: input.throughSequence,
				},
				() => original.compact(input),
			),
		events: (input: Parameters<DurableMessaging["events"]>[0]) =>
			guarded({ method: "events", scope: "instance" }, async () => {
				if (input.limit > bounds.eventPageSize) return privateLimit;
				return original.events(input);
			}),
	};
	const host: DurableMessagingWitHost = Object.freeze({
		limits: () => {
			if (
				!grant.active ||
				!metadataCurrent() ||
				lifecycle.unresolved ||
				(lifecycle.startPending && performance.now() >= lifecycle.startDeadline)
			)
				throw new Error("durable_messaging.unauthorized");
			return {
				...bounds,
				leaseMs: BigInt(bounds.leaseMs),
				operationWindowMs: BigInt(bounds.operationWindowMs),
			};
		},
		ensureTopic: (input) =>
			guardedMutation(input, async (op) => {
				const data = record(input, ["operation", "topic"]);
				const topic = text(data.topic, bounds.nameBytes);
				return guardedOutcome(
					op,
					() => calls.ensureTopic({ operation: op, topic }),
					(value) => {
						const receipt = record(value, ["topic"]);
						if (receipt.topic !== topic) return invalid();
						return { topic };
					},
				);
			}),
		ensureSubscription: (input) =>
			guardedMutation(input, async (op) => {
				const data = record(input, ["operation", "subscription"]);
				const expected = subscription(data.subscription, bounds);
				return guardedOutcome(
					op,
					() =>
						calls.ensureSubscription({ operation: op, subscription: expected }),
					(value) => {
						const receipt = record(value, [
							"subscription",
							"firstAvailableSequence",
							"historyTruncated",
						]);
						const actual = subscription(receipt.subscription, bounds);
						const first = integer(
							receipt.firstAvailableSequence,
							Number.MAX_SAFE_INTEGER,
							1,
						);
						if (
							actual.topic !== expected.topic ||
							actual.consumerGroup !== expected.consumerGroup ||
							actual.deadLetterTopic !== expected.deadLetterTopic ||
							actual.maxDeliveryAttempts !== expected.maxDeliveryAttempts ||
							actual.startAt !== expected.startAt ||
							typeof receipt.historyTruncated !== "boolean" ||
							receipt.historyTruncated !== first > 1
						)
							return invalid();
						return {
							subscription: { ...actual },
							firstAvailableSequence: BigInt(first),
							historyTruncated: receipt.historyTruncated,
						};
					},
				);
			}),
		publish: (input) =>
			guardedMutation(input, async (op) => {
				const data = record(input, ["operation", "topic", "message"]);
				const topic = text(data.topic, bounds.nameBytes);
				const captured = message(data.message, bounds);
				return guardedOutcome(
					op,
					() => calls.publish({ operation: op, topic, message: captured }),
					(value) => {
						const receipt = record(value, ["messageId", "sequence"]);
						if (receipt.messageId !== captured.id) return invalid();
						return {
							messageId: captured.id,
							sequence: BigInt(
								integer(receipt.sequence, Number.MAX_SAFE_INTEGER, 1),
							),
						};
					},
				);
			}),
		consume: (input) =>
			guardedMutation(input, async (op) => {
				const data = record(input, [
					"operation",
					"topic",
					"consumerGroup",
					"maxMessages",
					"visibilityTimeoutMs",
				]);
				const topic = text(data.topic, bounds.nameBytes);
				const consumerGroup = text(data.consumerGroup, bounds.nameBytes);
				const maxMessages = integer(data.maxMessages, bounds.batchSize, 1);
				const visibilityTimeoutMs = fromU64(
					data.visibilityTimeoutMs,
					bounds.leaseMs,
					1,
				);
				return guardedOutcome(
					op,
					() =>
						calls.consume({
							operation: op,
							topic,
							consumerGroup,
							maxMessages,
							visibilityTimeoutMs,
						}),
					(value) =>
						deliveries(value, topic, consumerGroup, maxMessages, bounds),
				);
			}),
		ack: (input) =>
			guardedMutation(input, async (op) => {
				const data = record(input, [
					"operation",
					"topic",
					"consumerGroup",
					"messageId",
					"sequence",
					"leaseId",
				]);
				const topic = text(data.topic, bounds.nameBytes);
				const consumerGroup = text(data.consumerGroup, bounds.nameBytes);
				const messageId = text(data.messageId, bounds.nameBytes);
				const sequence = fromU64(data.sequence, Number.MAX_SAFE_INTEGER, 1);
				const leaseId = text(data.leaseId, bounds.nameBytes);
				return guardedOutcome(
					op,
					() =>
						calls.ack({
							operation: op,
							topic,
							consumerGroup,
							messageId,
							sequence,
							leaseId,
						}),
					(value) => {
						const receipt = record(value, ["messageId", "sequence"]);
						if (
							receipt.messageId !== messageId ||
							receipt.sequence !== sequence
						)
							return invalid();
						return { messageId, sequence: BigInt(sequence) };
					},
				);
			}),
		nack: (input) =>
			guardedMutation(input, async (op) => {
				const data = record(input, [
					"operation",
					"topic",
					"consumerGroup",
					"messageId",
					"sequence",
					"leaseId",
					"reason",
				]);
				const topic = text(data.topic, bounds.nameBytes);
				const consumerGroup = text(data.consumerGroup, bounds.nameBytes);
				const messageId = text(data.messageId, bounds.nameBytes);
				const sequence = fromU64(data.sequence, Number.MAX_SAFE_INTEGER, 1);
				const leaseId = text(data.leaseId, bounds.nameBytes);
				const reason = text(data.reason, bounds.reasonBytes, true, true);
				return guardedOutcome(
					op,
					() =>
						calls.nack({
							operation: op,
							topic,
							consumerGroup,
							messageId,
							sequence,
							leaseId,
							reason,
						}),
					(value): Wit.NackReceipt => {
						const base = record(
							value,
							["messageId", "sequence", "disposition"],
							["deadLetterMessageId", "deadLetterSequence"],
						);
						if (base.messageId !== messageId || base.sequence !== sequence)
							return invalid();
						if (base.disposition === "released") {
							record(value, ["messageId", "sequence", "disposition"]);
							return {
								tag: "released",
								val: { messageId, sequence: BigInt(sequence) },
							};
						}
						if (base.disposition !== "dead-lettered") return invalid();
						const receipt = record(value, [
							"messageId",
							"sequence",
							"disposition",
							"deadLetterMessageId",
							"deadLetterSequence",
						]);
						return {
							tag: "dead-lettered",
							val: {
								messageId,
								sequence: BigInt(sequence),
								deadLetterMessageId: text(
									receipt.deadLetterMessageId,
									bounds.nameBytes,
								),
								deadLetterSequence: BigInt(
									integer(
										receipt.deadLetterSequence,
										Number.MAX_SAFE_INTEGER,
										1,
									),
								),
							},
						};
					},
				);
			}),
		compact: (input) =>
			guardedMutation(input, async (op) => {
				const data = record(input, ["operation", "topic", "throughSequence"]);
				const topic = text(data.topic, bounds.nameBytes);
				const throughSequence = fromU64(data.throughSequence);
				return guardedOutcome(
					op,
					() => calls.compact({ operation: op, topic, throughSequence }),
					(value) => {
						const receipt = record(value, [
							"topic",
							"firstAvailableSequence",
							"removedMessages",
						]);
						const first = integer(
							receipt.firstAvailableSequence,
							Number.MAX_SAFE_INTEGER,
							1,
						);
						const removed = integer(
							receipt.removedMessages,
							bounds.retainedMessages,
						);
						if (
							receipt.topic !== topic ||
							(removed > 0 && first - 1 > throughSequence)
						)
							return invalid();
						return {
							topic,
							firstAvailableSequence: BigInt(first),
							removedMessages: removed,
						};
					},
				);
			}),
		events: async (input) => {
			let afterSequence: number;
			let limit: number;
			try {
				const data = record(input, ["afterSequence", "limit"]);
				afterSequence = fromU64(data.afterSequence);
				limit = integer(data.limit, DURABLE_MESSAGING_LIMITS.eventPageSize, 1);
			} catch {
				return { tag: "rejected", val: "invalid-argument" };
			}
			try {
				const result = await calls.events({ afterSequence, limit });
				if (!metadataCurrent()) return invalid();
				if (result === privateLimit)
					return { tag: "rejected", val: "invalid-argument" };
				return eventsResult(result, afterSequence, limit, bounds);
			} catch {
				return { tag: "rejected", val: "unavailable" };
			}
		},
	});
	writePrivate(hostLifecycles, host, lifecycle);
	return host;
}

export function createDurableMessagingWitImports(
	port: DurableMessaging,
	options: DurableMessagingWitHostOptions,
): {
	readonly [DURABLE_MESSAGING_WIT_INTERFACE]: DurableMessagingWitHost;
} {
	return Object.freeze({
		[DURABLE_MESSAGING_WIT_INTERFACE]: createDurableMessagingWitHost(
			port,
			options,
		),
	});
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */

// public-contract: the exact opt-in component interface identity authorized by the JSPI host.
export const DURABLE_MESSAGING_JSPI_INTERFACE =
	"hobo:durable-messaging-jspi/messaging@0.1.0";
const JSPI_IMPORT_ALIAS = "hobo:durable-messaging-jspi/messaging";

export type DurableMessagingJspiImports = Readonly<{
	readonly [DURABLE_MESSAGING_JSPI_INTERFACE]: DurableMessagingWitHost;
	readonly [JSPI_IMPORT_ALIAS]: DurableMessagingWitHost;
}>;

export interface DurableMessagingJspiComponent<T> {
	readonly digest: string;
	readonly imports: readonly string[];
	readonly instantiate: (
		imports: DurableMessagingJspiImports,
	) => T | Promise<T>;
}

export interface DurableMessagingJspiOptions<T> {
	readonly component: DurableMessagingJspiComponent<T>;
	readonly verify: (
		component: DurableMessagingJspiComponent<T>,
		host: DurableMessagingWitHost,
	) => boolean;
	readonly timeoutMs?: number;
}

export type DurableMessagingJspiStart<T> =
	| { readonly status: "started"; readonly value: T }
	| { readonly status: "busy" }
	| { readonly status: "unknown" };

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: this gate inspects optional runtime capabilities and untrusted component metadata before invoking either. */
export function supportsDurableMessagingJspi(): boolean {
	if (typeof WebAssembly === "undefined" || types.isProxy(WebAssembly))
		return false;
	const suspending = Object.getOwnPropertyDescriptor(WebAssembly, "Suspending");
	const promising = Object.getOwnPropertyDescriptor(WebAssembly, "promising");
	return (
		suspending !== undefined &&
		Object.hasOwn(suspending, "value") &&
		promising !== undefined &&
		Object.hasOwn(promising, "value") &&
		typeof suspending.value === "function" &&
		!types.isProxy(suspending.value) &&
		typeof promising.value === "function" &&
		!types.isProxy(promising.value)
	);
}

export async function instantiateDurableMessagingJspi<T>(
	host: DurableMessagingWitHost,
	options: DurableMessagingJspiOptions<T>,
): Promise<DurableMessagingJspiStart<T>> {
	if (!supportsDurableMessagingJspi())
		throw new Error("durable_messaging.jspi_unavailable");
	if (typeof host !== "object" || host === null || types.isProxy(host))
		return invalid();
	const lifecycle = readPrivate(hostLifecycles, host);
	if (lifecycle === undefined) return invalid();
	const settings = record(options, ["component", "verify"], ["timeoutMs"]);
	const timeoutMs =
		settings.timeoutMs === undefined
			? 30_000
			: integer(settings.timeoutMs, 300_000, 1);
	const component = record(settings.component, [
		"digest",
		"imports",
		"instantiate",
	]);
	const digest = text(component.digest, 71);
	if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) return invalid();
	const imports = array(component.imports, 64).map((entry) => text(entry, 256));
	if (new Set(imports).size !== imports.length) return invalid();
	const matching = imports.filter(
		(entry) => entry.split("@")[0] === JSPI_IMPORT_ALIAS,
	);
	if (matching.length !== 1 || matching[0] !== DURABLE_MESSAGING_JSPI_INTERFACE)
		throw new Error("durable_messaging.jspi_interface_unverified");
	if (
		typeof component.instantiate !== "function" ||
		types.isProxy(component.instantiate) ||
		typeof settings.verify !== "function" ||
		types.isProxy(settings.verify)
	)
		return invalid();
	// SAFETY: the trusted host supplies a callable factory of the declared generic result.
	const instantiate =
		component.instantiate as DurableMessagingJspiComponent<T>["instantiate"];
	const captured = Object.freeze({
		digest,
		imports: Object.freeze(imports),
		instantiate,
	});
	let verified = false;
	try {
		verified = settings.verify(captured, host) === true;
	} catch {
	}
	if (!verified) throw new Error("durable_messaging.jspi_component_unverified");
	const table = Object.freeze({
		[DURABLE_MESSAGING_JSPI_INTERFACE]: host,
		[JSPI_IMPORT_ALIAS]: host,
	});
	if (lifecycle.unresolved) return { status: "unknown" };
	if (lifecycle.startPending || lifecycle.active !== 0)
		return { status: "busy" };
	lifecycle.startPending = true;
	lifecycle.startDeadline = performance.now() + timeoutMs;
	const work = Promise.resolve().then(async () => {
		try {
			if (lifecycle.unresolved || performance.now() >= lifecycle.startDeadline)
				throw new Error("durable_messaging.start_timeout");
			const value = await instantiate(table);
			if (
				lifecycle.unresolved ||
				performance.now() >= lifecycle.startDeadline ||
				lifecycle.active !== 0
			)
				throw new Error("durable_messaging.start_unresolved");
			return value;
		} catch (error) {
			lifecycle.unresolved = true;
			throw error;
		} finally {
			lifecycle.startPending = false;
		}
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			lifecycle.unresolved = true;
			reject(new Error("durable_messaging.start_timeout"));
		}, timeoutMs);
	});
	try {
		const value = await Promise.race([work, timeout]);
		if (lifecycle.unresolved || performance.now() >= lifecycle.startDeadline) {
			lifecycle.unresolved = true;
			return { status: "unknown" };
		}
		return { status: "started", value };
	} catch {
		lifecycle.unresolved = true;
		return { status: "unknown" };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/* oxlint-enable anti-slop/no-runtime-typeof */
