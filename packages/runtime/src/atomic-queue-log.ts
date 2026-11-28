import { types } from "node:util";
import type { DurableQueueLimits } from "@hobo/core";
import type { AtomicQueueRequest } from "./atomic-queue-transition.js";
import {
	parseQueueDequeue,
	parseQueueEnqueue,
	parseQueueExportConfirmation,
	parseQueueRedrive,
	parseQueueSettlement,
} from "./durable-queue-boundary.js";

export const ATOMIC_QUEUE_MAX_EVENTS = 512;
export const ATOMIC_QUEUE_MAX_BYTES = 256 * 1024;
export interface AtomicQueueCheckpointRef {
	readonly revision: number;
	readonly bytes: Uint8Array;
}
export interface AtomicQueueLog {
	readonly events: AtomicQueueEvent[];
	readonly checkpoint?: AtomicQueueCheckpointRef;
}
export interface AtomicQueueEvent {
	readonly atMs: number;
	readonly request: AtomicQueueRequest;
}
const parseJson = JSON.parse;
const stringifyJson = JSON.stringify;
const setPrototype = Object.setPrototypeOf;
const isArray = Array.isArray;
const isSafe = Number.isSafeInteger;
const apply = Reflect.apply;
const from = Buffer.from;
const bufferToString = Buffer.prototype.toString;
const NativeTextDecoder = TextDecoder;
const NativeTextEncoder = TextEncoder;
const decodeText = TextDecoder.prototype.decode;
const encodeText = TextEncoder.prototype.encode;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"byteLength",
)?.get;
const byteBuffer = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"buffer",
)?.get;
const byteSet = Uint8Array.prototype.set;

const limitNames = [
	"nameBytes",
	"payloadBytes",
	"attributeCount",
	"attributeBytes",
	"batchSize",
	"delayMs",
	"leaseMs",
	"operationWindowMs",
	"deliveryAttempts",
	"retainedMessages",
	"retainedReceipts",
] as const;
export function encodedLimits(limits: DurableQueueLimits): unknown[] {
	const result: unknown[] = [];
	for (let index = 0; index < limitNames.length; index++) {
		const key = limitNames[index];
		if (key === undefined) throw new TypeError("atomic_queue.invalid_limits");
		result[index] = limits[key];
	}
	return vector(result);
}

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply -- SAFETY: this codec accepts bounded durable state from the storage boundary. */
function invalid(): never {
	throw new TypeError("atomic_queue.invalid_log");
}
export function tuple(value: unknown, min: number, max = min): unknown[] {
	if (!isArray(value) || value.length < min || value.length > max)
		return invalid();
	return value;
}
function number(value: unknown): number {
	if (typeof value !== "number" || !isSafe(value) || value < 0)
		return invalid();
	return value;
}
function text(value: unknown, max: number): string {
	if (typeof value !== "string" || value.length > max) return invalid();
	return value;
}
export function vector(values: unknown[]): unknown[] {
	setPrototype(values, null);
	return values;
}
export function base64(value: Uint8Array): string {
	return apply(bufferToString, apply(from, Buffer, [value]), ["base64"]);
}
export function bytes(value: unknown, max: number): Uint8Array {
	const encoded = text(value, Math.ceil(max / 3) * 4);
	const decoded = apply(from, Buffer, [encoded, "base64"]);
	if (
		decoded.length > max ||
		apply(bufferToString, decoded, ["base64"]) !== encoded
	)
		return invalid();
	return new Uint8Array(decoded);
}
export function encodeEvent(event: AtomicQueueEvent): unknown[] {
	const request = event.request;
	const input = request.input;
	const op = input.operation;
	if (request.kind === "enqueue" && "message" in input) {
		const attrs: unknown[] = [];
		for (let index = 0; index < input.message.attributes.length; index++) {
			const attr = input.message.attributes[index];
			if (attr === undefined) return invalid();
			attrs[index] = vector([attr.key, attr.value]);
		}
		return vector([
			"e",
			event.atMs,
			op.id,
			op.expiresAtMs,
			input.message.idempotencyKey,
			base64(input.message.body),
			vector(attrs),
			input.message.availableAtMs ?? null,
		]);
	}
	if (
		request.kind === "confirmExport" &&
		"messageId" in input &&
		"exportReceipt" in input
	)
		return vector([
			"q",
			event.atMs,
			op.id,
			op.expiresAtMs,
			input.messageId,
			input.expectedRevision,
			input.exportReceipt,
		]);
	if (request.kind === "redrive" && "messageId" in input)
		return vector(["z", event.atMs, op.id, op.expiresAtMs, input.messageId]);
	if (request.kind === "dequeue" && "maxMessages" in input)
		return vector([
			"d",
			event.atMs,
			op.id,
			op.expiresAtMs,
			input.maxMessages,
			input.visibilityTimeoutMs,
		]);
	if (
		request.kind === "extendLease" &&
		"messageId" in input &&
		"visibilityTimeoutMs" in input
	)
		return vector([
			"x",
			event.atMs,
			op.id,
			op.expiresAtMs,
			input.messageId,
			input.leaseId,
			input.visibilityTimeoutMs,
		]);
	if (
		(request.kind === "complete" || request.kind === "release") &&
		"messageId" in input &&
		"leaseId" in input
	)
		return vector([
			request.kind === "complete" ? "c" : "r",
			event.atMs,
			op.id,
			op.expiresAtMs,
			input.messageId,
			input.leaseId,
		]);
	return invalid();
}
export function decodeEvent(
	value: unknown,
	limits: DurableQueueLimits,
): AtomicQueueEvent {
	const event = tuple(value, 5, 8);
	const kind = event[0];
	const atMs = number(event[1]);
	const operation = { id: text(event[2], 100), expiresAtMs: number(event[3]) };
	if (kind === "q") {
		if (event.length !== 7) return invalid();
		return {
			atMs,
			request: {
				kind: "confirmExport",
				input: parseQueueExportConfirmation(
					{
						operation,
						messageId: event[4],
						expectedRevision: event[5],
						exportReceipt: event[6],
					},
					limits,
				),
			},
		};
	}
	if (kind === "z") {
		if (event.length !== 5) return invalid();
		return {
			atMs,
			request: {
				kind: "redrive",
				input: parseQueueRedrive({ operation, messageId: event[4] }, limits),
			},
		};
	}
	if (kind === "e") {
		if (event.length !== 8) return invalid();
		const raw = tuple(event[6], 0, limits.attributeCount);
		const attributes: { key: unknown; value: unknown }[] = [];
		for (let index = 0; index < raw.length; index++) {
			const attr = tuple(raw[index], 2);
			attributes[index] = { key: attr[0], value: attr[1] };
		}
		const message = {
			idempotencyKey: event[4],
			body: bytes(event[5], limits.payloadBytes),
			attributes,
		};
		const normalized =
			event[7] === null ? message : { ...message, availableAtMs: event[7] };
		return {
			atMs,
			request: {
				kind: "enqueue",
				input: parseQueueEnqueue(
					{ operation, message: normalized },
					limits,
					"port",
				),
			},
		};
	}
	if (kind === "d") {
		if (event.length !== 6) return invalid();
		return {
			atMs,
			request: {
				kind: "dequeue",
				input: parseQueueDequeue(
					{ operation, maxMessages: event[4], visibilityTimeoutMs: event[5] },
					limits,
					"port",
				),
			},
		};
	}
	if (kind === "x") {
		if (event.length !== 7) return invalid();
		return {
			atMs,
			request: {
				kind: "extendLease",
				input: parseQueueSettlement(
					{
						operation,
						messageId: event[4],
						leaseId: event[5],
						visibilityTimeoutMs: event[6],
					},
					limits,
					true,
					"port",
				),
			},
		};
	}
	if (kind === "c" || kind === "r") {
		if (event.length !== 6) return invalid();
		return {
			atMs,
			request: {
				kind: kind === "c" ? "complete" : "release",
				input: parseQueueSettlement(
					{ operation, messageId: event[4], leaseId: event[5] },
					limits,
					false,
					"port",
				),
			},
		};
	}
	return invalid();
}
export function encodeAtomicQueueLog(
	events: readonly AtomicQueueEvent[],
	limits: DurableQueueLimits,
	checkpoint?: AtomicQueueCheckpointRef,
): Uint8Array {
	if (events.length > ATOMIC_QUEUE_MAX_EVENTS) return invalid();
	const encoded: unknown[] = [];
	for (let index = 0; index < events.length; index++) {
		const event = events[index];
		if (event === undefined) return invalid();
		encoded[index] = encodeEvent(event);
	}
	if (
		checkpoint !== undefined &&
		(!isSafe(checkpoint.revision) || checkpoint.revision < 1)
	)
		return invalid();
	return serializeVector(
		vector([
			2,
			encodedLimits(limits),
			checkpoint?.revision ?? 0,
			checkpoint === undefined ? null : base64(checkpoint.bytes),
			vector(encoded),
		]),
	);
}
export function serializeVector(value: unknown[]): Uint8Array {
	const data: Uint8Array = apply(encodeText, new NativeTextEncoder(), [
		stringifyJson(value),
	]);
	if (data.length > ATOMIC_QUEUE_MAX_BYTES) return invalid();
	return data;
}
export function parseVector(data: Uint8Array): unknown[] {
	if (
		types.isProxy(data) ||
		!types.isUint8Array(data) ||
		byteLength === undefined ||
		byteBuffer === undefined
	)
		return invalid();
	const length: unknown = apply(byteLength, data, []);
	const buffer: unknown = apply(byteBuffer, data, []);
	if (
		typeof length !== "number" ||
		!isSafe(length) ||
		length < 0 ||
		length > ATOMIC_QUEUE_MAX_BYTES ||
		types.isSharedArrayBuffer(buffer)
	)
		return invalid();
	const snapshot = new Uint8Array(length);
	apply(byteSet, snapshot, [data]);
	const decoded: string = apply(
		decodeText,
		new NativeTextDecoder("utf-8", { fatal: true }),
		[snapshot],
	);
	return tuple(parseJson(decoded), 0, ATOMIC_QUEUE_MAX_BYTES);
}

export function decodeAtomicQueueLog(
	data: Uint8Array,
	limits: DurableQueueLimits,
): AtomicQueueLog {
	const root = tuple(parseVector(data), 5);
	if (root[0] !== 2) return invalid();
	const storedLimits = tuple(root[1], limitNames.length);
	for (let index = 0; index < limitNames.length; index++) {
		const key = limitNames[index];
		if (key === undefined || storedLimits[index] !== limits[key])
			return invalid();
	}
	const baseRevision = number(root[2]);
	if ((baseRevision === 0) !== (root[3] === null)) return invalid();
	const checkpoint =
		root[3] === null
			? undefined
			: {
					revision: baseRevision,
					bytes: bytes(root[3], ATOMIC_QUEUE_MAX_BYTES),
				};
	const raw = tuple(root[4], 0, ATOMIC_QUEUE_MAX_EVENTS);
	const events: AtomicQueueEvent[] = [];
	let last = 0;
	for (let index = 0; index < raw.length; index++) {
		const event = decodeEvent(raw[index], limits);
		if (event.atMs < last) return invalid();
		last = event.atMs;
		events[index] = event;
	}
	return checkpoint === undefined ? { events } : { events, checkpoint };
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply */
