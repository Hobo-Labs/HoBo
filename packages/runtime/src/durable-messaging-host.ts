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
const intrinsicArrayMap = Array.prototype.map;
function mapArray<T, U>(
	items: readonly T[],
	mapper: (value: T, index: number) => U,
): U[] {
	// SAFETY: the captured intrinsic maps this checked array with the supplied callback.
	return intrinsicApply(intrinsicArrayMap, items, [mapper]) as U[];
}
const intrinsicWeakGet = WeakMap.prototype.get;
const intrinsicWeakSet = WeakMap.prototype.set;

function readPrivate<K extends object, V>(
	table: WeakMap<K, V>,
	key: K,
): V | undefined {
	// SAFETY: the private table determines the value type for this key.
	return intrinsicApply(intrinsicWeakGet, table, [key]) as V | undefined;
}
function writePrivate<K extends object, V>(
	table: WeakMap<K, V>,
	key: K,
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
	const attributes = mapArray(
		array(data.attributes, bounds.attributeCount),
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
	return mapArray(array(value, maximum), (item) => {
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
	const entries = mapArray(array(data.events, maximum), (entry) =>
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

export interface DurableTopicSubscriptionGrant {
	readonly consumerGroup: string;
	readonly deadLetterTopic: string;
}

export interface DurableTopicGrant {
	readonly topic: string;
	readonly publish: boolean;
	readonly subscriptions: readonly DurableTopicSubscriptionGrant[];
}

export interface DurableTopicPolicyClaim {
	readonly request: DurableMessagingAuthorization;
	readonly grant: DurableTopicGrant;
	readonly subscription?: DurableTopicSubscriptionGrant;
}

export interface DurableTopicPolicy {
	readonly authorize: (
		request: DurableMessagingAuthorization,
	) => Promise<boolean>;
	readonly revoke: () => void;
}

export interface DurableTopicBinding {
	readonly resourceName: string;
	readonly topic: string;
	readonly subscriptions: readonly DurableTopicSubscriptionGrant[];
}

export interface BindleTopicGrant {
	readonly resourceName: string;
	readonly grant: DurableTopicGrant;
}

export function compileBindleTopicGrants(input: {
	readonly applicationName: string;
	readonly resources: Readonly<
		Record<
			string,
			{
				readonly kind: string;
				readonly name: string;
				readonly declaredAllow: readonly string[];
				readonly dependsOn: readonly string[];
			}
		>
	>;
	readonly edges: readonly { readonly from: string; readonly to: string }[];
	readonly bindings: readonly DurableTopicBinding[];
}): readonly BindleTopicGrant[] {
	const inputData = record(input, [
		"applicationName",
		"resources",
		"edges",
		"bindings",
	]);
	const applicationName = text(
		inputData.applicationName,
		DURABLE_MESSAGING_LIMITS.nameBytes,
	);
	const source = inputData.resources;
	if (
		typeof source !== "object" ||
		source === null ||
		types.isProxy(source) ||
		Array.isArray(source)
	)
		return invalid();
	const prototype = Object.getPrototypeOf(source);
	if (prototype !== Object.prototype && prototype !== null) return invalid();
	const names = Reflect.ownKeys(source);
	if (names.length > 256 || names.some((name) => typeof name !== "string"))
		return invalid();
	const resources = new Map<
		string,
		{
			kind: string;
			declaredAllow: readonly string[];
			dependsOn: readonly string[];
		}
	>();
	for (const key of names) {
		if (typeof key !== "string") return invalid();
		const name = text(key, DURABLE_MESSAGING_LIMITS.nameBytes);
		const descriptor = Object.getOwnPropertyDescriptor(source, key);
		if (
			descriptor === undefined ||
			!Object.hasOwn(descriptor, "value") ||
			!descriptor.enumerable
		)
			return invalid();
		const resource = record(
			descriptor.value,
			["kind", "name", "declaredAllow", "dependsOn"],
			["stableId", "annotations"],
		);
		if (resource.name !== name) return invalid();
		const kind = text(resource.kind, DURABLE_MESSAGING_LIMITS.nameBytes);
		const declaredAllow = mapArray(
			array(resource.declaredAllow, 256),
			(value) => text(value, DURABLE_MESSAGING_LIMITS.nameBytes),
		);
		const dependsOn = mapArray(array(resource.dependsOn, 256), (value) =>
			text(value, DURABLE_MESSAGING_LIMITS.nameBytes),
		);
		if (new Set(declaredAllow).size !== declaredAllow.length) return invalid();
		resources.set(name, { kind, declaredAllow, dependsOn });
	}
	const application = resources.get(applicationName);
	if (application === undefined || application.kind === "topic")
		return invalid();
	const selected = new Set<string>();
	for (const item of array(inputData.edges, 1024)) {
		const edge = record(item, ["from", "to"]);
		const from = text(edge.from, DURABLE_MESSAGING_LIMITS.nameBytes);
		const to = text(edge.to, DURABLE_MESSAGING_LIMITS.nameBytes);
		if (from !== applicationName) continue;
		const target = resources.get(to);
		if (target === undefined && to.startsWith("connector:")) continue;
		if (target === undefined) return invalid();
		if (target.kind === "topic") {
			if (selected.has(to)) return invalid();
			selected.add(to);
		}
	}
	if (
		application.dependsOn.filter((kind) => kind === "topic").length !==
		selected.size
	)
		return invalid();
	const bindings = array(inputData.bindings, DURABLE_MESSAGING_LIMITS.topics);
	if (bindings.length !== selected.size) return invalid();
	const seen = new Set<string>();
	const namesUsed = new Set<string>();
	let subscriptionCount = 0;
	const result: BindleTopicGrant[] = [];
	for (const value of bindings) {
		const binding = record(value, ["resourceName", "topic", "subscriptions"]);
		const resourceName = text(
			binding.resourceName,
			DURABLE_MESSAGING_LIMITS.nameBytes,
		);
		const topic = text(binding.topic, DURABLE_MESSAGING_LIMITS.nameBytes);
		const resource = resources.get(resourceName);
		if (
			!selected.has(resourceName) ||
			seen.has(resourceName) ||
			namesUsed.has(topic) ||
			resource === undefined ||
			resource.declaredAllow.some(
				(verb) => verb !== "publish" && verb !== "subscribe",
			)
		)
			return invalid();
		const groups = new Set<string>();
		const subscriptions = mapArray(
			array(binding.subscriptions, DURABLE_MESSAGING_LIMITS.subscriptions),
			(item) => {
				const entry = record(item, ["consumerGroup", "deadLetterTopic"]);
				const consumerGroup = text(
					entry.consumerGroup,
					DURABLE_MESSAGING_LIMITS.nameBytes,
				);
				const deadLetterTopic = text(
					entry.deadLetterTopic,
					DURABLE_MESSAGING_LIMITS.nameBytes,
				);
				if (
					groups.has(consumerGroup) ||
					deadLetterTopic === topic ||
					++subscriptionCount > DURABLE_MESSAGING_LIMITS.subscriptions
				)
					return invalid();
				groups.add(consumerGroup);
				return Object.freeze({ consumerGroup, deadLetterTopic });
			},
		);
		if (
			resource.declaredAllow.includes("subscribe") !==
			subscriptions.length > 0
		)
			return invalid();
		seen.add(resourceName);
		namesUsed.add(topic);
		result.push(
			Object.freeze({
				resourceName,
				grant: Object.freeze({
					topic,
					publish: resource.declaredAllow.includes("publish"),
					subscriptions: Object.freeze(subscriptions),
				}),
			}),
		);
	}
	return Object.freeze(
		result.sort((a, b) => a.resourceName.localeCompare(b.resourceName)),
	);
}

export function createDurableTopicPolicy(input: {
	readonly grants: readonly DurableTopicGrant[];
	readonly verify: (
		claim: DurableTopicPolicyClaim,
	) => boolean | Promise<boolean>;
}): DurableTopicPolicy {
	const config = record(input, ["grants", "verify"]);
	if (typeof config.verify !== "function" || types.isProxy(config.verify))
		return invalid();
	const verify = config.verify;
	const topics = new Set<string>();
	let subscriptionCount = 0;
	const grants = mapArray(
		array(config.grants, DURABLE_MESSAGING_LIMITS.topics),
		(item) => {
			const data = record(item, ["topic", "publish", "subscriptions"]);
			const topic = text(data.topic, DURABLE_MESSAGING_LIMITS.nameBytes);
			if (
				topics.has(topic) ||
				(data.publish !== true && data.publish !== false)
			)
				return invalid();
			topics.add(topic);
			const groups = new Set<string>();
			const subscriptions = mapArray(
				array(data.subscriptions, DURABLE_MESSAGING_LIMITS.subscriptions),
				(entry) => {
					const data = record(entry, ["consumerGroup", "deadLetterTopic"]);
					const consumerGroup = text(
						data.consumerGroup,
						DURABLE_MESSAGING_LIMITS.nameBytes,
					);
					const deadLetterTopic = text(
						data.deadLetterTopic,
						DURABLE_MESSAGING_LIMITS.nameBytes,
					);
					if (
						groups.has(consumerGroup) ||
						deadLetterTopic === topic ||
						++subscriptionCount > DURABLE_MESSAGING_LIMITS.subscriptions
					)
						return invalid();
					groups.add(consumerGroup);
					return Object.freeze({ consumerGroup, deadLetterTopic });
				},
			);
			return Object.freeze({
				topic,
				publish: data.publish,
				subscriptions: Object.freeze(subscriptions),
			});
		},
	);
	let active = true;
	return Object.freeze({
		revoke: () => {
			active = false;
		},
		authorize: async (
			request: DurableMessagingAuthorization,
		): Promise<boolean> => {
			if (!active) return false;
			const grant = grants.find((item) => item.topic === request.topic);
			if (!grant) return false;
			let subscription: DurableTopicSubscriptionGrant | undefined;
			if (request.method === "publish") {
				if (!grant.publish || request.scope !== "topic") return false;
			} else if (
				["ensureSubscription", "consume", "ack", "nack"].includes(
					request.method,
				)
			) {
				subscription = grant.subscriptions.find(
					(item) => item.consumerGroup === request.consumerGroup,
				);
				if (
					!subscription ||
					(request.method === "ensureSubscription" &&
						request.deadLetterTopic !== subscription.deadLetterTopic)
				)
					return false;
				if (
					request.scope !==
					(request.method === "ack"
						? "consumer-group"
						: "consumer-group-and-dead-letter")
				)
					return false;
			} else return false;
			const claim = Object.freeze(
				subscription === undefined
					? { request, grant }
					: { request, grant, subscription },
			);
			try {
				return (
					(await intrinsicApply(verify, undefined, [claim])) === true && active
				);
			} catch {
				return false;
			}
		},
	});
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
			if (lifecycle.unresolved)
				return Promise.reject(new Error("durable_messaging.unauthorized"));
			return bounded(async (alive) => {
				if (!grant.active || !metadataCurrent() || !alive())
					throw new Error("durable_messaging.unauthorized");
				return {
					...bounds,
					leaseMs: BigInt(bounds.leaseMs),
					operationWindowMs: BigInt(bounds.operationWindowMs),
				};
			});
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

export interface BindleTopicHostClaim {
	readonly port: DurableMessaging;
	readonly bindleName: string;
	readonly applicationName: string;
	readonly binding: BindleTopicGrant;
	readonly request: DurableMessagingAuthorization;
	readonly subscription?: DurableTopicSubscriptionGrant;
}

export interface BindleTopicClient {
	readonly publishEnabled: boolean;
	readonly subscriptions: readonly DurableTopicSubscriptionGrant[];
	publish(
		input: Omit<Wit.PublishRequest, "topic">,
	): Promise<Wit.PublishOutcome>;
	ensureSubscription(input: {
		readonly operation: Wit.Operation;
		readonly consumerGroup: string;
		readonly maxDeliveryAttempts: number;
		readonly startAt: Wit.StartAt;
	}): Promise<Wit.SubscriptionOutcome>;
	consume(
		input: Omit<Wit.ConsumeRequest, "topic">,
	): Promise<Wit.ConsumeOutcome>;
	ack(
		input: Omit<Wit.AcknowledgementRequest, "topic">,
	): Promise<Wit.MessageOutcome>;
	nack(input: Omit<Wit.RejectionRequest, "topic">): Promise<Wit.NackOutcome>;
}

export function createBindleTopicWitHost(
	port: DurableMessaging,
	bindle: Parameters<typeof compileBindleTopicGrants>[0] & {
		readonly bindleName: string;
	},
	options: Omit<DurableMessagingWitHostOptions, "authorize"> & {
		readonly verify: (
			claim: BindleTopicHostClaim,
		) => boolean | Promise<boolean>;
	},
): {
	readonly host: DurableMessagingWitHost;
	readonly bindings: readonly BindleTopicGrant[];
	readonly topic: (resourceName: string) => BindleTopicClient;
	readonly revoke: () => void;
} {
	const config = record(
		options,
		["limitsGrant", "lifecycle", "verify"],
		["timeoutMs", "portMetadataGrant"],
	);
	if (typeof config.verify !== "function" || types.isProxy(config.verify))
		return invalid();
	const verify = config.verify;
	const source = record(bindle, [
		"bindleName",
		"applicationName",
		"resources",
		"edges",
		"bindings",
	]);
	const bindleName = text(
		source.bindleName,
		DURABLE_MESSAGING_LIMITS.nameBytes,
	);
	const applicationName = text(
		source.applicationName,
		DURABLE_MESSAGING_LIMITS.nameBytes,
	);
	// SAFETY: the compiler validates all captured graph and binding fields.
	const bindings = compileBindleTopicGrants({
		applicationName,
		resources: source.resources,
		edges: source.edges,
		bindings: source.bindings,
	} as Parameters<typeof compileBindleTopicGrants>[0]);
	const byTopic = new Map(
		mapArray(bindings, (binding) => [binding.grant.topic, binding]),
	);
	const policy = createDurableTopicPolicy({
		grants: mapArray(bindings, (binding) => binding.grant),
		verify: (claim) => {
			const binding = byTopic.get(claim.grant.topic);
			if (binding === undefined) return false;
			const context = Object.freeze(
				claim.subscription === undefined
					? {
							port,
							bindleName,
							applicationName,
							binding,
							request: claim.request,
						}
					: {
							port,
							bindleName,
							applicationName,
							binding,
							request: claim.request,
							subscription: claim.subscription,
						},
			);
			return intrinsicApply(verify, undefined, [context]);
		},
	});
	const hostOptions = {
		...config,
		authorize: policy.authorize,
	};
	Reflect.deleteProperty(hostOptions, "verify");
	// SAFETY: the host validates the captured option fields and capability identities.
	const host = createDurableMessagingWitHost(
		port,
		hostOptions as DurableMessagingWitHostOptions,
	);
	const byResource = new Map(
		mapArray(bindings, (binding) => [binding.resourceName, binding]),
	);
	const topic = (resourceName: string): BindleTopicClient => {
		const binding = byResource.get(
			text(resourceName, DURABLE_MESSAGING_LIMITS.nameBytes),
		);
		if (binding === undefined) return invalid();
		const call = async <T>(
			input: unknown,
			fields: readonly string[],
			run: (
				data: Record<string, unknown>,
				op: DurableMessagingOperation,
			) => Promise<WitOutcome<T>>,
		): Promise<WitOutcome<T>> => {
			const op = requestOperation(input);
			try {
				return await run(record(input, ["operation", ...fields]), op);
			} catch {
				return { tag: "unknown", val: witOperation(op) };
			}
		};
		return Object.freeze({
			publishEnabled: binding.grant.publish,
			subscriptions: binding.grant.subscriptions,
			publish: (input: Omit<Wit.PublishRequest, "topic">) =>
				call(input, ["message"], (data, op) =>
					host.publish({
						operation: witOperation(op),
						topic: binding.grant.topic,
						message: witMessage(data.message, DURABLE_MESSAGING_LIMITS),
					}),
				),
			ensureSubscription: (
				input: Parameters<BindleTopicClient["ensureSubscription"]>[0],
			) =>
				call(
					input,
					["consumerGroup", "maxDeliveryAttempts", "startAt"],
					(data, op) => {
						const group = text(
							data.consumerGroup,
							DURABLE_MESSAGING_LIMITS.nameBytes,
						);
						const destination = binding.grant.subscriptions.find(
							(item) => item.consumerGroup === group,
						);
						if (destination === undefined)
							return Promise.resolve({ tag: "unknown", val: witOperation(op) });
						if (data.startAt !== "earliest" && data.startAt !== "latest")
							return invalid();
						return host.ensureSubscription({
							operation: witOperation(op),
							subscription: {
								topic: binding.grant.topic,
								consumerGroup: group,
								deadLetterTopic: destination.deadLetterTopic,
								maxDeliveryAttempts: integer(
									data.maxDeliveryAttempts,
									DURABLE_MESSAGING_LIMITS.deliveryAttempts,
									1,
								),
								startAt: data.startAt,
							},
						});
					},
				),
			consume: (input: Omit<Wit.ConsumeRequest, "topic">) =>
				call(
					input,
					["consumerGroup", "maxMessages", "visibilityTimeoutMs"],
					(data, op) =>
						host.consume({
							operation: witOperation(op),
							topic: binding.grant.topic,
							consumerGroup: text(
								data.consumerGroup,
								DURABLE_MESSAGING_LIMITS.nameBytes,
							),
							maxMessages: integer(
								data.maxMessages,
								DURABLE_MESSAGING_LIMITS.batchSize,
								1,
							),
							visibilityTimeoutMs: BigInt(
								fromU64(
									data.visibilityTimeoutMs,
									DURABLE_MESSAGING_LIMITS.leaseMs,
									1,
								),
							),
						}),
				),
			ack: (input: Omit<Wit.AcknowledgementRequest, "topic">) =>
				call(
					input,
					["consumerGroup", "messageId", "sequence", "leaseId"],
					(data, op) =>
						host.ack({
							operation: witOperation(op),
							topic: binding.grant.topic,
							consumerGroup: text(
								data.consumerGroup,
								DURABLE_MESSAGING_LIMITS.nameBytes,
							),
							messageId: text(
								data.messageId,
								DURABLE_MESSAGING_LIMITS.nameBytes,
							),
							sequence: BigInt(
								fromU64(data.sequence, Number.MAX_SAFE_INTEGER, 1),
							),
							leaseId: text(data.leaseId, DURABLE_MESSAGING_LIMITS.nameBytes),
						}),
				),
			nack: (input: Omit<Wit.RejectionRequest, "topic">) =>
				call(
					input,
					["consumerGroup", "messageId", "sequence", "leaseId", "reason"],
					(data, op) =>
						host.nack({
							operation: witOperation(op),
							topic: binding.grant.topic,
							consumerGroup: text(
								data.consumerGroup,
								DURABLE_MESSAGING_LIMITS.nameBytes,
							),
							messageId: text(
								data.messageId,
								DURABLE_MESSAGING_LIMITS.nameBytes,
							),
							sequence: BigInt(
								fromU64(data.sequence, Number.MAX_SAFE_INTEGER, 1),
							),
							leaseId: text(data.leaseId, DURABLE_MESSAGING_LIMITS.nameBytes),
							reason: text(
								data.reason,
								DURABLE_MESSAGING_LIMITS.reasonBytes,
								true,
								true,
							),
						}),
				),
		});
	};
	return Object.freeze({ host, bindings, topic, revoke: policy.revoke });
}
export interface BindleTopicProvisionOperation {
	readonly topic: string;
	readonly operation: DurableMessagingOperation;
}

export type BindleTopicProvisionResult =
	| {
			readonly status: "complete";
			readonly completed: readonly BindleTopicProvisionOperation[];
	  }
	| { readonly status: "limits-unavailable"; readonly completed: readonly [] }
	| { readonly status: "capacity-exceeded"; readonly completed: readonly [] }
	| {
			readonly status: "incomplete";
			readonly completed: readonly BindleTopicProvisionOperation[];
			readonly failed: BindleTopicProvisionOperation;
			readonly outcome: Exclude<
				Wit.TopicOutcome,
				{ readonly tag: "committed" }
			>;
			readonly notAttempted: readonly string[];
	  };

export async function provisionBindleTopics(
	port: DurableMessaging,
	bindle: Parameters<typeof compileBindleTopicGrants>[0],
	operations: readonly BindleTopicProvisionOperation[],
	options: DurableMessagingWitHostOptions,
): Promise<BindleTopicProvisionResult> {
	return provisionCompiledBindleTopics(
		port,
		compileBindleTopicGrants(bindle),
		operations,
		options,
	);
}

async function provisionCompiledBindleTopics(
	port: DurableMessaging,
	grants: readonly BindleTopicGrant[],
	operations: readonly BindleTopicProvisionOperation[],
	options: DurableMessagingWitHostOptions,
): Promise<BindleTopicProvisionResult> {
	const topics = new Set<string>();
	for (const binding of grants) {
		topics.add(binding.grant.topic);
		for (const subscription of binding.grant.subscriptions)
			topics.add(subscription.deadLetterTopic);
	}
	if (topics.size > DURABLE_MESSAGING_LIMITS.topics)
		return Object.freeze({
			status: "capacity-exceeded",
			completed: Object.freeze([] as const),
		});
	const names = [...topics].sort();
	const provided = array(operations, DURABLE_MESSAGING_LIMITS.topics);
	if (provided.length !== names.length) return invalid();
	const byTopic = new Map<string, BindleTopicProvisionOperation>();
	const identifiers = new Set<string>();
	for (const entry of provided) {
		const item = record(entry, ["topic", "operation"]);
		const topic = text(item.topic, DURABLE_MESSAGING_LIMITS.nameBytes);
		const op = providerOperation(item.operation);
		if (!topics.has(topic) || byTopic.has(topic) || identifiers.has(op.id))
			return invalid();
		identifiers.add(op.id);
		byTopic.set(topic, Object.freeze({ topic, operation: op }));
	}
	const config = record(
		options,
		["authorize", "limitsGrant", "lifecycle"],
		["timeoutMs", "portMetadataGrant"],
	);
	if (typeof config.authorize !== "function" || types.isProxy(config.authorize))
		return invalid();
	const authorize = config.authorize;
	const hostConfig = {
		...config,
		authorize: (request: DurableMessagingAuthorization) =>
			request.method === "ensureTopic" &&
			request.scope === "topic" &&
			request.topic !== undefined &&
			topics.has(request.topic) &&
			intrinsicApply(authorize, undefined, [request]),
	};
	// SAFETY: the host validates the captured capability fields and authority callback.
	const host = createDurableMessagingWitHost(
		port,
		hostConfig as DurableMessagingWitHostOptions,
	);
	let bounds: Awaited<ReturnType<DurableMessagingWitHost["limits"]>>;
	try {
		bounds = await host.limits();
	} catch {
		return Object.freeze({
			status: "limits-unavailable",
			completed: Object.freeze([] as const),
		});
	}
	if (
		names.length > bounds.topics ||
		names.some(
			(name) => new TextEncoder().encode(name).length > bounds.nameBytes,
		)
	)
		return Object.freeze({
			status: "capacity-exceeded",
			completed: Object.freeze([] as const),
		});
	const completed: BindleTopicProvisionOperation[] = [];
	for (let index = 0; index < names.length; index++) {
		const name = names[index];
		if (name === undefined) return invalid();
		const entry = byTopic.get(name);
		if (!entry) return invalid();
		const outcome = await host.ensureTopic({
			topic: name,
			operation: witOperation(entry.operation),
		});
		if (outcome.tag !== "committed")
			return Object.freeze({
				status: "incomplete",
				completed: Object.freeze([...completed]),
				failed: entry,
				outcome,
				notAttempted: Object.freeze(names.slice(index + 1)),
			});
		completed.push(entry);
	}
	return Object.freeze({
		status: "complete",
		completed: Object.freeze(completed),
	});
}

export async function prepareBindleTopicWitHost(
	port: DurableMessaging,
	bindle: Parameters<typeof createBindleTopicWitHost>[1],
	operations: readonly BindleTopicProvisionOperation[],
	options: {
		readonly provisioning: DurableMessagingWitHostOptions;
		readonly application: Parameters<typeof createBindleTopicWitHost>[2];
	},
): Promise<
	| {
			readonly status: "ready";
			readonly provisioning: Extract<
				BindleTopicProvisionResult,
				{ status: "complete" }
			>;
			readonly application: ReturnType<typeof createBindleTopicWitHost>;
	  }
	| {
			readonly status: "unavailable";
			readonly provisioning: Exclude<
				BindleTopicProvisionResult,
				{ status: "complete" }
			>;
	  }
> {
	const config = record(options, ["provisioning", "application"]);
	// SAFETY: the host validates its options and snapshots the graph synchronously.
	const application = createBindleTopicWitHost(
		port,
		bindle,
		config.application as Parameters<typeof createBindleTopicWitHost>[2],
	);
	try {
		// SAFETY: the provisioner validates the captured options before awaiting.
		const provisioning = await provisionCompiledBindleTopics(
			port,
			application.bindings,
			operations,
			config.provisioning as DurableMessagingWitHostOptions,
		);
		if (provisioning.status !== "complete") {
			application.revoke();
			return Object.freeze({ status: "unavailable", provisioning });
		}
		return Object.freeze({ status: "ready", provisioning, application });
	} catch (error) {
		application.revoke();
		throw error;
	}
}

export function createBindleTopicPreparation(
	port: DurableMessaging,
	bindle: Parameters<typeof createBindleTopicWitHost>[1],
	operations: readonly BindleTopicProvisionOperation[],
	options: Parameters<typeof prepareBindleTopicWitHost>[3],
): () => ReturnType<typeof prepareBindleTopicWitHost> {
	const source = record(bindle, [
		"bindleName",
		"applicationName",
		"resources",
		"edges",
		"bindings",
	]);
	const bindleName = text(
		source.bindleName,
		DURABLE_MESSAGING_LIMITS.nameBytes,
	);
	const applicationName = text(
		source.applicationName,
		DURABLE_MESSAGING_LIMITS.nameBytes,
	);
	// SAFETY: the compiler validates and snapshots each graph field.
	const grants = compileBindleTopicGrants({
		applicationName,
		resources: source.resources,
		edges: source.edges,
		bindings: source.bindings,
	} as Parameters<typeof compileBindleTopicGrants>[0]);
	const resources: Record<
		string,
		{ kind: string; name: string; declaredAllow: string[]; dependsOn: string[] }
	> = Object.create(null);
	resources[applicationName] = {
		kind: "application",
		name: applicationName,
		declaredAllow: [],
		dependsOn: mapArray(grants, () => "topic"),
	};
	const edges: { from: string; to: string }[] = [];
	const bindings: DurableTopicBinding[] = [];
	for (const { resourceName, grant } of grants) {
		resources[resourceName] = {
			kind: "topic",
			name: resourceName,
			declaredAllow: [
				...(grant.publish ? ["publish"] : []),
				...(grant.subscriptions.length ? ["subscribe"] : []),
			],
			dependsOn: [],
		};
		edges.push({ from: applicationName, to: resourceName });
		bindings.push({
			resourceName,
			topic: grant.topic,
			subscriptions: grant.subscriptions,
		});
	}
	const snapshot = { bindleName, applicationName, resources, edges, bindings };
	const captured = mapArray(
		array(operations, DURABLE_MESSAGING_LIMITS.topics),
		(entry) => {
			const item = record(entry, ["topic", "operation"]);
			return Object.freeze({
				topic: text(item.topic, DURABLE_MESSAGING_LIMITS.nameBytes),
				operation: providerOperation(item.operation),
			});
		},
	);
	const config = record(options, ["provisioning", "application"]);
	const provisioning: unknown = Object.freeze(
		record(
			config.provisioning,
			["authorize", "limitsGrant", "lifecycle"],
			["timeoutMs", "portMetadataGrant"],
		),
	);
	const application: unknown = Object.freeze(
		record(
			config.application,
			["limitsGrant", "lifecycle", "verify"],
			["timeoutMs", "portMetadataGrant"],
		),
	);
	let pending: ReturnType<typeof prepareBindleTopicWitHost> | undefined;
	let ready:
		| Extract<
				Awaited<ReturnType<typeof prepareBindleTopicWitHost>>,
				{ status: "ready" }
		  >
		| undefined;
	return () => {
		if (ready !== undefined) return Promise.resolve(ready);
		if (pending !== undefined) return pending;
		// SAFETY: preparation validates both captured option records before use.
		pending = Promise.resolve()
			.then(() =>
				prepareBindleTopicWitHost(port, snapshot, captured, {
					provisioning: provisioning as DurableMessagingWitHostOptions,
					application: application as Parameters<
						typeof createBindleTopicWitHost
					>[2],
				}),
			)
			.then((result) => {
				if (result.status === "ready") ready = result;
				return result;
			})
			.finally(() => {
				pending = undefined;
			});
		return pending;
	};
}

/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */

export { DURABLE_MESSAGING_WIT_INTERFACE };

const NATIVE_IMPORT_ALIAS = "hobo:durable-messaging/messaging";

export type DurableMessagingAsyncImports = Readonly<{
	readonly [DURABLE_MESSAGING_WIT_INTERFACE]: DurableMessagingWitHost;
	readonly [NATIVE_IMPORT_ALIAS]: DurableMessagingWitHost;
}>;

export interface DurableMessagingAsyncComponent<T> {
	readonly digest: string;
	readonly imports: readonly string[];
	readonly instantiate: (
		imports: DurableMessagingAsyncImports,
	) => T | Promise<T>;
}

export interface DurableMessagingAsyncOptions<T> {
	readonly component: DurableMessagingAsyncComponent<T>;
	readonly verify: (
		component: DurableMessagingAsyncComponent<T>,
		host: DurableMessagingWitHost,
	) => boolean;
	readonly timeoutMs?: number;
}

export type DurableMessagingAsyncStart<T> =
	| { readonly status: "started"; readonly value: T }
	| { readonly status: "busy" }
	| { readonly status: "unknown" };

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: this gate inspects optional runtime capabilities and untrusted component metadata before invoking either. */
export function supportsDurableMessagingAsync(): boolean {
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

export async function instantiateDurableMessagingAsync<T>(
	host: DurableMessagingWitHost,
	options: DurableMessagingAsyncOptions<T>,
): Promise<DurableMessagingAsyncStart<T>> {
	if (!supportsDurableMessagingAsync())
		throw new Error("durable_messaging.async_unavailable");
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
	const imports = mapArray(array(component.imports, 64), (entry) =>
		text(entry, 256),
	);
	if (new Set(imports).size !== imports.length) return invalid();
	const matching = imports.filter(
		(entry) => entry.split("@")[0] === NATIVE_IMPORT_ALIAS,
	);
	if (matching.length !== 1 || matching[0] !== DURABLE_MESSAGING_WIT_INTERFACE)
		throw new Error("durable_messaging.async_interface_unverified");
	if (
		typeof component.instantiate !== "function" ||
		types.isProxy(component.instantiate) ||
		typeof settings.verify !== "function" ||
		types.isProxy(settings.verify)
	)
		return invalid();
	// SAFETY: the trusted host supplies a callable factory of the declared generic result.
	const instantiate =
		component.instantiate as DurableMessagingAsyncComponent<T>["instantiate"];
	const captured = Object.freeze({
		digest,
		imports: Object.freeze(imports),
		instantiate,
	});
	let verified = false;
	try {
		verified = settings.verify(captured, host) === true;
	} catch {}
	if (!verified)
		throw new Error("durable_messaging.async_component_unverified");
	const table = Object.freeze({
		[DURABLE_MESSAGING_WIT_INTERFACE]: host,
		[NATIVE_IMPORT_ALIAS]: host,
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
