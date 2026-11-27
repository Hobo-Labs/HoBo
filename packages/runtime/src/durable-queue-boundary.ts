import { types } from "node:util";
import {
	type DurableQueue,
	type DurableQueueLimits,
	type DurableQueueOperation,
	type DurableQueueOutcome,
	type DurableQueueDelivery,
	type DurableQueueRejectionCode,
	parseDurableQueueOperation,
} from "@hobo/core";

const apply = Reflect.apply;
const ownKeys = Reflect.ownKeys;
const descriptor = Object.getOwnPropertyDescriptor;
const prototype = Object.getPrototypeOf;
const isProxy = types.isProxy;
const isArray = Array.isArray;
const hasOwn = Object.hasOwn;
const isSafeInteger = Number.isSafeInteger;
const isUint8Array = types.isUint8Array;
const isSharedArrayBuffer = types.isSharedArrayBuffer;
const typedArrayPrototype = prototype(Uint8Array.prototype);
const byteLength = descriptor(typedArrayPrototype, "byteLength")?.get;
const byteBuffer = descriptor(typedArrayPrototype, "buffer")?.get;
const byteSet = Uint8Array.prototype.set;
const utf8Length = Buffer.byteLength;
const exec = RegExp.prototype.exec;
const invalidUnicode = /[\p{Cs}\p{Cc}]/u;
const nativeBigInt = BigInt;
const nativeNumber = Number;

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply, anti-slop/no-unsafe-dictionary-type -- SAFETY: component input is copied and checked before entering a provider. */
function invalid(): never {
	throw new TypeError("durable_queue.invalid_boundary_value");
}

function record(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	if (
		typeof value !== "object" ||
		value === null ||
		isProxy(value) ||
		isArray(value)
	)
		return invalid();
	const proto = prototype(value);
	if (proto !== Object.prototype && proto !== null) return invalid();
	const keys = ownKeys(value);
	if (keys.length > required.length + optional.length) return invalid();
	const result: Record<string, unknown> = Object.create(null);
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		if (
			typeof key !== "string" ||
			(!required.includes(key) && !optional.includes(key))
		)
			return invalid();
		const field = descriptor(value, key);
		if (field === undefined || !field.enumerable || !hasOwn(field, "value"))
			return invalid();
		result[key] = field.value;
	}
	for (let i = 0; i < required.length; i++) {
		const key = required[i];
		if (key === undefined || !hasOwn(result, key)) return invalid();
	}
	return result;
}

function array(value: unknown, max: number): unknown[] {
	if (isProxy(value) || !isArray(value)) return invalid();
	const length = descriptor(value, "length")?.value;
	if (
		!isSafeInteger(length) ||
		length < 0 ||
		length > max ||
		ownKeys(value).length !== length + 1
	)
		return invalid();
	const copy: unknown[] = [];
	for (let i = 0; i < length; i++) {
		const field = descriptor(value, String(i));
		if (field === undefined || !field.enumerable || !hasOwn(field, "value"))
			return invalid();
		copy[i] = field.value;
	}
	return copy;
}

function text(value: unknown, max: number, empty = false): string {
	if (
		typeof value !== "string" ||
		(!empty && value.length === 0) ||
		value.length > max ||
		apply(exec, invalidUnicode, [value]) !== null ||
		utf8Length(value, "utf8") > max
	)
		return invalid();
	return value;
}

function integer(value: unknown, max: number, min = 0): number {
	if (
		typeof value !== "number" ||
		!isSafeInteger(value) ||
		value < min ||
		value > max
	)
		return invalid();
	return value;
}

function u64(value: unknown, max: number, min = 0): number {
	if (
		typeof value !== "bigint" ||
		value < nativeBigInt(min) ||
		value > nativeBigInt(max)
	)
		return invalid();
	return nativeNumber(value);
}

function bytes(value: unknown, max: number): Uint8Array {
	if (
		isProxy(value) ||
		!isUint8Array(value) ||
		byteLength === undefined ||
		byteBuffer === undefined
	)
		return invalid();
	const length: unknown = apply(byteLength, value, []);
	const buffer: unknown = apply(byteBuffer, value, []);
	if (
		typeof length !== "number" ||
		!isSafeInteger(length) ||
		length < 0 ||
		length > max ||
		isSharedArrayBuffer(buffer)
	)
		return invalid();
	const proto = prototype(value);
	if (proto !== Uint8Array.prototype && proto !== Buffer.prototype)
		return invalid();
	if (ownKeys(value).length !== length) return invalid();
	const copy = new Uint8Array(length);
	apply(byteSet, copy, [value]);
	return copy;
}

function operation(value: unknown) {
	const input = record(value, ["id", "expiresAtMs"]);
	return parseDurableQueueOperation({
		id: input.id,
		expiresAtMs: u64(input.expiresAtMs, Number.MAX_SAFE_INTEGER),
	});
}

export function parseQueueEnqueue(
	value: unknown,
	limits: DurableQueueLimits,
): Parameters<DurableQueue["enqueue"]>[0] {
	const input = record(value, ["operation", "message"]);
	const message = record(
		input.message,
		["idempotencyKey", "body", "attributes"],
		["availableAtMs"],
	);
	const attrs = array(message.attributes, limits.attributeCount);
	let attributeBytes = 0;
	const attributes = attrs.map((entry) => {
		const item = record(entry, ["key", "value"]);
		const key = text(item.key, limits.attributeBytes);
		const val = text(item.value, limits.attributeBytes, true);
		attributeBytes += utf8Length(key, "utf8") + utf8Length(val, "utf8");
		if (attributeBytes > limits.attributeBytes) return invalid();
		return { key, value: val };
	});
	const availableAtMs =
		message.availableAtMs === undefined
			? undefined
			: u64(message.availableAtMs, Number.MAX_SAFE_INTEGER);
	const content = {
		idempotencyKey: text(message.idempotencyKey, limits.nameBytes),
		body: bytes(message.body, limits.payloadBytes),
		attributes,
	};
	return {
		operation: operation(input.operation),
		message:
			availableAtMs === undefined ? content : { ...content, availableAtMs },
	};
}

export function parseQueueDequeue(
	value: unknown,
	limits: DurableQueueLimits,
): Parameters<DurableQueue["dequeue"]>[0] {
	const input = record(value, [
		"operation",
		"maxMessages",
		"visibilityTimeoutMs",
	]);
	return {
		operation: operation(input.operation),
		maxMessages: integer(input.maxMessages, limits.batchSize, 1),
		visibilityTimeoutMs: u64(input.visibilityTimeoutMs, limits.leaseMs, 1),
	};
}

export function parseQueueSettlement(
	value: unknown,
	limits: DurableQueueLimits,
	extended: false,
): Parameters<DurableQueue["complete"]>[0];
export function parseQueueSettlement(
	value: unknown,
	limits: DurableQueueLimits,
	extended: true,
): Parameters<DurableQueue["extendLease"]>[0];
export function parseQueueSettlement(
	value: unknown,
	limits: DurableQueueLimits,
	extended: boolean,
):
	| Parameters<DurableQueue["complete"]>[0]
	| Parameters<DurableQueue["extendLease"]>[0] {
	const input = record(
		value,
		extended
			? ["operation", "messageId", "leaseId", "visibilityTimeoutMs"]
			: ["operation", "messageId", "leaseId"],
	);
	const base = {
		operation: operation(input.operation),
		messageId: text(input.messageId, limits.nameBytes),
		leaseId: text(input.leaseId, limits.nameBytes),
	};
	return extended
		? {
				...base,
				visibilityTimeoutMs: u64(input.visibilityTimeoutMs, limits.leaseMs, 1),
			}
		: base;
}
type QueueResultKind = "enqueue" | "dequeue" | "settlement" | "extension";
type QueueResultValue =
	| { readonly messageId: string; readonly idempotencyKey: string }
	| readonly DurableQueueDelivery[]
	| { readonly messageId: string; readonly leaseId: string }
	| DurableQueueDelivery;

const rejectionCodes: readonly DurableQueueRejectionCode[] = [
	"invalid-argument",
	"unauthorized",
	"not-found",
	"unsupported",
	"operation-conflict",
	"message-conflict",
	"lease-lost",
	"capacity-exceeded",
	"unavailable",
];

function providerOperation(
	value: unknown,
	expected: DurableQueueOperation,
): DurableQueueOperation {
	const actual = parseDurableQueueOperation(value);
	if (actual.id !== expected.id || actual.expiresAtMs !== expected.expiresAtMs)
		return invalid();
	return expected;
}

function delivery(
	value: unknown,
	limits: DurableQueueLimits,
): DurableQueueDelivery {
	const item = record(value, [
		"messageId",
		"leaseId",
		"idempotencyKey",
		"body",
		"attributes",
		"leaseExpiresAtMs",
		"deliveryAttempt",
	]);
	const attrs = array(item.attributes, limits.attributeCount);
	let total = 0;
	const attributes = attrs.map((entry) => {
		const attr = record(entry, ["key", "value"]);
		const key = text(attr.key, limits.attributeBytes);
		const val = text(attr.value, limits.attributeBytes, true);
		total += utf8Length(key, "utf8") + utf8Length(val, "utf8");
		if (total > limits.attributeBytes) return invalid();
		return { key, value: val };
	});
	return {
		messageId: text(item.messageId, limits.nameBytes),
		leaseId: text(item.leaseId, limits.nameBytes),
		idempotencyKey: text(item.idempotencyKey, limits.nameBytes),
		body: bytes(item.body, limits.payloadBytes),
		attributes,
		leaseExpiresAtMs: integer(item.leaseExpiresAtMs, Number.MAX_SAFE_INTEGER),
		deliveryAttempt: integer(item.deliveryAttempt, limits.deliveryAttempts, 1),
	};
}

export function parseQueueProviderOutcome(
	value: unknown,
	expected: DurableQueueOperation,
	limits: DurableQueueLimits,
	request: {
		readonly kind: QueueResultKind;
		readonly messageId?: string;
		readonly leaseId?: string;
		readonly idempotencyKey?: string;
		readonly maxMessages?: number;
	},
): DurableQueueOutcome<QueueResultValue> {
	const outer = record(value, ["status"], ["value", "code", "operation"]);
	if (outer.status === "unknown" || outer.status === "expired") {
		const result = record(value, ["status", "operation"]);
		return {
			status: outer.status,
			operation: providerOperation(result.operation, expected),
		};
	}
	if (outer.status === "rejected") {
		const result = record(value, ["status", "code"]);
		const code = rejectionCodes.find((candidate) => candidate === result.code);
		if (code === undefined) return invalid();
		return { status: "rejected", code };
	}
	if (outer.status !== "committed") return invalid();
	const result = record(value, ["status", "value"]);
	if (request.kind === "enqueue") {
		const receipt = record(result.value, ["messageId", "idempotencyKey"]);
		const messageId = text(receipt.messageId, limits.nameBytes);
		const idempotencyKey = text(receipt.idempotencyKey, limits.nameBytes);
		if (idempotencyKey !== request.idempotencyKey) return invalid();
		return { status: "committed", value: { messageId, idempotencyKey } };
	}
	if (request.kind === "dequeue") {
		if (request.maxMessages === undefined) return invalid();
		const items = array(result.value, request.maxMessages).map((item) =>
			delivery(item, limits),
		);
		const ids = new Set(items.map((item) => item.messageId));
		if (ids.size !== items.length) return invalid();
		return { status: "committed", value: items };
	}
	if (request.kind === "extension") {
		const item = delivery(result.value, limits);
		if (
			item.messageId !== request.messageId ||
			item.leaseId !== request.leaseId
		)
			return invalid();
		return { status: "committed", value: item };
	}
	const receipt = record(result.value, ["messageId", "leaseId"]);
	const messageId = text(receipt.messageId, limits.nameBytes);
	const leaseId = text(receipt.leaseId, limits.nameBytes);
	if (messageId !== request.messageId || leaseId !== request.leaseId)
		return invalid();
	return { status: "committed", value: { messageId, leaseId } };
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply, anti-slop/no-unsafe-dictionary-type */
