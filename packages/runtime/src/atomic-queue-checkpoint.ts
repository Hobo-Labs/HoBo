import type { DurableQueueDelivery, DurableQueueLimits } from "@hobo/core";
import {
	base64,
	bytes,
	decodeEvent,
	encodedLimits,
	encodeEvent,
	parseVector,
	serializeVector,
	tuple,
	vector,
} from "./atomic-queue-log.js";
import {
	ATOMIC_QUEUE_MAX_SEQUENCE,
	type AtomicQueueMessage,
	type AtomicQueueReceipt,
	type AtomicQueueRequest,
	type AtomicQueueState,
	fingerprint,
	messageSignature,
	type QueueResult,
} from "./atomic-queue-transition.js";
import {
	parseQueueEnqueue,
	parseQueueProviderOutcome,
} from "./durable-queue-boundary.js";

const isSafe = Number.isSafeInteger;
const isArray = Array.isArray;
const number = Number;
const apply = Reflect.apply;
const regexExec = RegExp.prototype.exec;
const slice = String.prototype.slice;
const leasePattern = /^l[1-9][0-9]{0,14}$/u;
const messagePattern = /^m[1-9][0-9]{0,14}$/u;
const SetType = Set;
const setHas = Set.prototype.has;
const setAdd = Set.prototype.add;

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply, anti-slop/no-known-value-widening -- SAFETY: checkpoints are bounded untrusted storage data. */
function invalid(): never {
	throw new TypeError("atomic_queue.invalid_checkpoint");
}
function integer(
	value: unknown,
	min = 0,
	max = Number.MAX_SAFE_INTEGER,
): number {
	if (typeof value !== "number" || !isSafe(value) || value < min || value > max)
		return invalid();
	return value;
}
function text(value: unknown, max: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max)
		return invalid();
	return value;
}
function attrs(input: DurableQueueDelivery["attributes"]): unknown[] {
	const result: unknown[] = [];
	for (let index = 0; index < input.length; index++) {
		const attr = input[index];
		if (attr === undefined) return invalid();
		result[index] = vector([attr.key, attr.value]);
	}
	return vector(result);
}
function decodeAttrs(
	input: unknown,
	limits: DurableQueueLimits,
): { key: unknown; value: unknown }[] {
	const raw = tuple(input, 0, limits.attributeCount);
	const result: { key: unknown; value: unknown }[] = [];
	for (let index = 0; index < raw.length; index++) {
		const attr = tuple(raw[index], 2);
		result[index] = { key: attr[0], value: attr[1] };
	}
	return result;
}
function messageVector(message: AtomicQueueMessage): unknown[] {
	return vector([
		message.messageId,
		message.signature,
		message.idempotencyKey,
		base64(message.body),
		attrs(message.attributes),
		message.availableAtMs,
		message.requestedAvailableAtMs,
		message.deliveryAttempt,
		message.leaseId,
		message.leaseExpiresAtMs,
		message.completed,
	]);
}
function deliveryVector(message: DurableQueueDelivery): unknown[] {
	return vector([
		message.messageId,
		message.leaseId,
		message.idempotencyKey,
		base64(message.body),
		attrs(message.attributes),
		message.leaseExpiresAtMs,
		message.deliveryAttempt,
	]);
}
export function resultVector(receipt: AtomicQueueReceipt): unknown[] {
	const result = receipt.result;
	if (result.status === "rejected") return vector(["r", result.code]);
	const value = result.value;
	if (receipt.request.kind === "dequeue") {
		if (!isArray(value)) return invalid();
		const deliveries: unknown[] = [];
		for (let index = 0; index < value.length; index++)
			deliveries[index] = deliveryVector(value[index]);
		return vector(["d", vector(deliveries)]);
	}
	if (receipt.request.kind === "extendLease") {
		if (!("body" in value)) return invalid();
		return vector(["x", deliveryVector(value)]);
	}
	if (receipt.request.kind === "enqueue") {
		if (!("idempotencyKey" in value) || "body" in value) return invalid();
		return vector(["e", value.messageId, value.idempotencyKey]);
	}
	if (!("messageId" in value) || !("leaseId" in value)) return invalid();
	return vector(["s", value.messageId, value.leaseId]);
}
function rawDelivery(value: unknown, limits: DurableQueueLimits): object {
	const entry = tuple(value, 7);
	return {
		messageId: entry[0],
		leaseId: entry[1],
		idempotencyKey: entry[2],
		body: bytes(entry[3], limits.payloadBytes),
		attributes: decodeAttrs(entry[4], limits),
		leaseExpiresAtMs: entry[5],
		deliveryAttempt: entry[6],
	};
}
function decodeResult(
	value: unknown,
	request: AtomicQueueRequest,
	limits: DurableQueueLimits,
): QueueResult {
	const raw = tuple(value, 2, 3);
	let response: object;
	if (raw[0] === "r" && raw.length === 2)
		response = { status: "rejected", code: raw[1] };
	else if (raw[0] === "e" && raw.length === 3 && request.kind === "enqueue")
		response = {
			status: "committed",
			value: { messageId: raw[1], idempotencyKey: raw[2] },
		};
	else if (
		raw[0] === "s" &&
		raw.length === 3 &&
		(request.kind === "complete" || request.kind === "release")
	)
		response = {
			status: "committed",
			value: { messageId: raw[1], leaseId: raw[2] },
		};
	else if (raw[0] === "x" && raw.length === 2 && request.kind === "extendLease")
		response = { status: "committed", value: rawDelivery(raw[1], limits) };
	else if (raw[0] === "d" && raw.length === 2 && request.kind === "dequeue") {
		const entries = tuple(raw[1], 0, request.input.maxMessages);
		const deliveries: object[] = [];
		for (let index = 0; index < entries.length; index++)
			deliveries[index] = rawDelivery(entries[index], limits);
		response = { status: "committed", value: deliveries };
	} else return invalid();
	const expected =
		request.kind === "enqueue"
			? {
					kind: "enqueue" as const,
					idempotencyKey: request.input.message.idempotencyKey,
				}
			: request.kind === "dequeue"
				? { kind: "dequeue" as const, maxMessages: request.input.maxMessages }
				: request.kind === "extendLease"
					? {
							kind: "extension" as const,
							messageId: request.input.messageId,
							leaseId: request.input.leaseId,
						}
					: {
							kind: "settlement" as const,
							messageId: request.input.messageId,
							leaseId: request.input.leaseId,
						};
	const result = parseQueueProviderOutcome(
		response,
		request.input.operation,
		limits,
		expected,
	);
	if (result.status !== "committed" && result.status !== "rejected")
		return invalid();
	return result;
}
function validateLease(lease: string, nextLease: number): void {
	if (
		apply(regexExec, leasePattern, [lease]) === null ||
		number(apply(slice, lease, [1])) >= nextLease
	)
		invalid();
}
function matchMessage(
	messageId: string,
	messages: readonly AtomicQueueMessage[],
): AtomicQueueMessage {
	if (apply(regexExec, messagePattern, [messageId]) === null) return invalid();
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message?.messageId === messageId) return message;
	}
	return invalid();
}
function validateDelivery(
	value: DurableQueueDelivery,
	messages: readonly AtomicQueueMessage[],
	nextLease: number,
): void {
	const message = matchMessage(value.messageId, messages);
	validateLease(value.leaseId, nextLease);
	if (
		value.idempotencyKey !== message.idempotencyKey ||
		value.deliveryAttempt > message.deliveryAttempt ||
		value.body.length !== message.body.length ||
		value.attributes.length !== message.attributes.length ||
		value.leaseExpiresAtMs === 0
	)
		invalid();
	for (let index = 0; index < value.body.length; index++)
		if (value.body[index] !== message.body[index]) invalid();
	for (let index = 0; index < value.attributes.length; index++) {
		const actual = value.attributes[index];
		const expected = message.attributes[index];
		if (
			actual === undefined ||
			expected === undefined ||
			actual.key !== expected.key ||
			actual.value !== expected.value
		)
			invalid();
	}
}
function validateReceipt(
	result: QueueResult,
	request: AtomicQueueRequest,
	messages: readonly AtomicQueueMessage[],
	nextLease: number,
): void {
	if (result.status === "rejected") return;
	const value = result.value;
	if (request.kind === "enqueue") {
		if (
			!("messageId" in value) ||
			!("idempotencyKey" in value) ||
			"body" in value
		)
			invalid();
		const message = matchMessage(value.messageId, messages);
		if (
			value.idempotencyKey !== message.idempotencyKey ||
			messageSignature(request.input.message) !== message.signature
		)
			invalid();
		return;
	}
	if (request.kind === "dequeue") {
		if (!isArray(value)) invalid();
		for (let index = 0; index < value.length; index++)
			validateDelivery(value[index], messages, nextLease);
		return;
	}
	if (request.kind === "extendLease") {
		if (!("body" in value)) invalid();
		validateDelivery(value, messages, nextLease);
		return;
	}
	if (!("messageId" in value) || !("leaseId" in value)) invalid();
	matchMessage(value.messageId, messages);
	validateLease(value.leaseId, nextLease);
}

export function encodeAtomicQueueCheckpoint(
	state: AtomicQueueState,
	atMs: number,
	limits: DurableQueueLimits,
): Uint8Array {
	const messages: unknown[] = [];
	for (let index = 0; index < state.messages.length; index++) {
		const message = state.messages[index];
		if (message === undefined) return invalid();
		messages[index] = messageVector(message);
	}
	const receipts: unknown[] = [];
	for (let index = 0; index < state.receipts.length; index++) {
		const receipt = state.receipts[index];
		if (receipt === undefined) return invalid();
		if (receipt.expiresAtMs > atMs)
			receipts[receipts.length] = vector([
				encodeEvent({ atMs: 0, request: receipt.request }),
				resultVector(receipt),
			]);
	}
	return serializeVector(
		vector([
			1,
			encodedLimits(limits),
			atMs,
			state.nextMessage,
			state.nextLease,
			vector(messages),
			vector(receipts),
		]),
	);
}
export function decodeAtomicQueueCheckpoint(
	data: Uint8Array,
	limits: DurableQueueLimits,
): { readonly atMs: number; readonly state: AtomicQueueState } {
	const root = tuple(parseVector(data), 7);
	if (root[0] !== 1) return invalid();
	const expectedLimits = encodedLimits(limits);
	const actualLimits = tuple(root[1], expectedLimits.length);
	for (let index = 0; index < expectedLimits.length; index++)
		if (actualLimits[index] !== expectedLimits[index]) return invalid();
	const atMs = integer(root[2]);
	const nextMessage = integer(root[3], 1, ATOMIC_QUEUE_MAX_SEQUENCE);
	const nextLease = integer(root[4], 1, ATOMIC_QUEUE_MAX_SEQUENCE);
	const rawMessages = tuple(root[5], 0, limits.retainedMessages);
	const messages: AtomicQueueMessage[] = [];
	const keys = new SetType<string>();
	const leases = new SetType<string>();
	let previousMessage = 0;
	for (let index = 0; index < rawMessages.length; index++) {
		const item = tuple(rawMessages[index], 11);
		const messageId = text(item[0], limits.nameBytes);
		if (apply(regexExec, messagePattern, [messageId]) === null)
			return invalid();
		const sequence = number(apply(slice, messageId, [1]));
		if (
			!isSafe(sequence) ||
			sequence <= previousMessage ||
			sequence >= nextMessage
		)
			return invalid();
		previousMessage = sequence;
		const requested = item[6] === null ? undefined : integer(item[6]);
		const rawContent = {
			idempotencyKey: item[2],
			body: bytes(item[3], limits.payloadBytes),
			attributes: decodeAttrs(item[4], limits),
		};
		const content =
			requested === undefined
				? rawContent
				: { ...rawContent, availableAtMs: requested };
		const parsed = parseQueueEnqueue(
			{
				operation: { id: "v1.0.abcdefghijklmnop", expiresAtMs: 0 },
				message: content,
			},
			limits,
			"port",
		).message;
		if (apply(setHas, keys, [parsed.idempotencyKey])) return invalid();
		apply(setAdd, keys, [parsed.idempotencyKey]);
		const signature = text(
			item[1],
			2 * limits.payloadBytes + 2 * limits.attributeBytes + 200,
		);
		if (signature !== messageSignature(parsed)) return invalid();
		const availableAtMs = integer(item[5]);
		const deliveryAttempt = integer(item[7], 0, limits.deliveryAttempts);
		const leaseId = item[8] === null ? null : text(item[8], limits.nameBytes);
		const leaseExpiresAtMs = integer(item[9]);
		if (typeof item[10] !== "boolean") return invalid();
		const completed = item[10];
		if (completed && deliveryAttempt === 0) return invalid();
		if (leaseId === null && leaseExpiresAtMs !== 0) return invalid();
		if (leaseId !== null) {
			validateLease(leaseId, nextLease);
			if (
				completed ||
				deliveryAttempt === 0 ||
				leaseExpiresAtMs === 0 ||
				apply(setHas, leases, [leaseId])
			)
				return invalid();
			apply(setAdd, leases, [leaseId]);
		}
		messages[index] = {
			messageId,
			signature,
			idempotencyKey: parsed.idempotencyKey,
			body: parsed.body,
			attributes: parsed.attributes,
			availableAtMs,
			requestedAvailableAtMs: requested ?? null,
			deliveryAttempt,
			leaseId,
			leaseExpiresAtMs,
			completed,
		};
	}
	const rawReceipts = tuple(root[6], 0, limits.retainedReceipts);
	const receipts: AtomicQueueReceipt[] = [];
	const ids = new SetType<string>();
	for (let index = 0; index < rawReceipts.length; index++) {
		const raw = tuple(rawReceipts[index], 2);
		const event = decodeEvent(raw[0], limits);
		if (
			event.atMs !== 0 ||
			event.request.input.operation.expiresAtMs <= atMs ||
			apply(setHas, ids, [event.request.input.operation.id])
		)
			return invalid();
		apply(setAdd, ids, [event.request.input.operation.id]);
		const result = decodeResult(raw[1], event.request, limits);
		validateReceipt(result, event.request, messages, nextLease);
		receipts[index] = {
			id: event.request.input.operation.id,
			expiresAtMs: event.request.input.operation.expiresAtMs,
			fingerprint: fingerprint(event.request),
			request: event.request,
			result,
		};
	}
	return { atMs, state: { nextMessage, nextLease, messages, receipts } };
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply, anti-slop/no-known-value-widening */
