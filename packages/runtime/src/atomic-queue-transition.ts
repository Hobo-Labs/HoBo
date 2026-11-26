import type {
	DurableQueue,
	DurableQueueDelivery,
	DurableQueueLimits,
	DurableQueueOperation,
	DurableQueueOutcome,
	DurableQueueRejectionCode,
} from "@hobo/core";

export type AtomicQueueRequest =
	| {
			readonly kind: "confirmExport";
			readonly input: {
				readonly operation: DurableQueueOperation;
				readonly messageId: string;
				readonly expectedRevision: number;
				readonly exportReceipt: string;
			};
	  }
	| {
			readonly kind: "redrive";
			readonly input: {
				readonly operation: DurableQueueOperation;
				readonly messageId: string;
			};
	  }
	| {
			readonly kind: "enqueue";
			readonly input: Parameters<DurableQueue["enqueue"]>[0];
	  }
	| {
			readonly kind: "dequeue";
			readonly input: Parameters<DurableQueue["dequeue"]>[0];
	  }
	| {
			readonly kind: "complete" | "release";
			readonly input: Parameters<DurableQueue["complete"]>[0];
	  }
	| {
			readonly kind: "extendLease";
			readonly input: Parameters<DurableQueue["extendLease"]>[0];
	  };

type QueueValue =
	| { readonly messageId: string; readonly idempotencyKey: string }
	| readonly DurableQueueDelivery[]
	| { readonly messageId: string; readonly leaseId: string }
	| DurableQueueDelivery;
export type QueueResult = Extract<
	DurableQueueOutcome<QueueValue>,
	{ status: "committed" | "rejected" }
>;
export interface AtomicQueueMessage {
	readonly messageId: string;
	readonly signature: string;
	readonly idempotencyKey: string;
	readonly body: Uint8Array;
	readonly attributes: DurableQueueDelivery["attributes"];
	readonly availableAtMs: number;
	readonly requestedAvailableAtMs: number | null;
	readonly deliveryAttempt: number;
	readonly leaseId: string | null;
	readonly leaseExpiresAtMs: number;
	readonly completed: boolean;
}
export interface AtomicQueueReceipt {
	readonly id: string;
	readonly expiresAtMs: number;
	readonly fingerprint: string;
	readonly request: AtomicQueueRequest;
	readonly result: QueueResult;
}
export interface AtomicQueueState {
	readonly nextMessage: number;
	readonly nextLease: number;
	readonly messages: readonly AtomicQueueMessage[];
	readonly receipts: readonly AtomicQueueReceipt[];
}
export interface AtomicQueueTransition {
	readonly state: AtomicQueueState;
	readonly outcome: DurableQueueOutcome<QueueValue>;
	readonly changed: boolean;
}

const nativeApply = Reflect.apply;
const nativeBufferFrom = Buffer.from;
const nativeBufferToString = Buffer.prototype.toString;
const nativeArray = Array.isArray;
const nativeNumber = Number.isSafeInteger;
const nativeString = String;
const maxSafe = Number.MAX_SAFE_INTEGER;
export const ATOMIC_QUEUE_MAX_SEQUENCE = 1_000_000_000_000_000;
const NativeBytes = Uint8Array;
export function emptyAtomicQueueState(): AtomicQueueState {
	return { nextMessage: 1, nextLease: 1, messages: [], receipts: [] };
}
function field(value: string): string {
	return `${value.length}:${value}`;
}
function copyAttributes(
	input: DurableQueueDelivery["attributes"],
): { key: string; value: string }[] {
	const copy: { key: string; value: string }[] = [];
	for (let index = 0; index < input.length; index++) {
		const attr = input[index];
		if (attr === undefined)
			throw new TypeError("atomic_queue.invalid_attributes");
		copy[index] = { key: attr.key, value: attr.value };
	}
	return copy;
}
export function messageSignature(
	input: Parameters<DurableQueue["enqueue"]>[0]["message"],
): string {
	const encoded = nativeApply(
		nativeBufferToString,
		nativeApply(nativeBufferFrom, Buffer, [input.body]),
		["base64"],
	);
	let signature = field(nativeString(encoded)) + `${input.attributes.length};`;
	for (let index = 0; index < input.attributes.length; index++) {
		const attr = input.attributes[index];
		if (attr === undefined)
			throw new TypeError("atomic_queue.invalid_attributes");
		signature += field(attr.key) + field(attr.value);
	}
	return (
		signature +
		(input.availableAtMs === undefined ? "-" : `+${input.availableAtMs}`)
	);
}
export function fingerprint(request: AtomicQueueRequest): string {
	const input = request.input;
	if (
		request.kind === "confirmExport" &&
		"messageId" in input &&
		"exportReceipt" in input
	)
		return `q${field(input.messageId)}${input.expectedRevision};${field(input.exportReceipt)}`;
	if (request.kind === "redrive" && "messageId" in input)
		return `z${field(input.messageId)}`;
	if (request.kind === "enqueue" && "message" in input)
		return `e${field(input.message.idempotencyKey)}${messageSignature(input.message)}`;
	if (request.kind === "dequeue" && "maxMessages" in input)
		return `d${input.maxMessages};${input.visibilityTimeoutMs}`;
	if (
		request.kind === "extendLease" &&
		"messageId" in input &&
		"visibilityTimeoutMs" in input
	)
		return `x${field(input.messageId)}${field(input.leaseId)}${input.visibilityTimeoutMs}`;
	if (
		(request.kind === "complete" || request.kind === "release") &&
		"messageId" in input &&
		"leaseId" in input
	)
		return `${request.kind === "complete" ? "c" : "r"}${field(input.messageId)}${field(input.leaseId)}`;
	throw new TypeError("atomic_queue.invalid_request");
}
function copyDelivery(input: DurableQueueDelivery): DurableQueueDelivery {
	return {
		...input,
		body: new NativeBytes(input.body),
		attributes: copyAttributes(input.attributes),
	};
}
function delivery(message: AtomicQueueMessage): DurableQueueDelivery {
	if (message.leaseId === null)
		throw new TypeError("atomic_queue.invalid_lease");
	return {
		messageId: message.messageId,
		leaseId: message.leaseId,
		idempotencyKey: message.idempotencyKey,
		body: new NativeBytes(message.body),
		attributes: copyAttributes(message.attributes),
		leaseExpiresAtMs: message.leaseExpiresAtMs,
		deliveryAttempt: message.deliveryAttempt,
	};
}
function copyRequest(request: AtomicQueueRequest): AtomicQueueRequest {
	if (request.kind === "enqueue")
		return {
			kind: "enqueue",
			input: {
				operation: { ...request.input.operation },
				message: {
					...request.input.message,
					body: new NativeBytes(request.input.message.body),
					attributes: copyAttributes(request.input.message.attributes),
				},
			},
		};
	if (request.kind === "dequeue")
		return {
			kind: "dequeue",
			input: { ...request.input, operation: { ...request.input.operation } },
		};
	if (request.kind === "confirmExport")
		return {
			kind: "confirmExport",
			input: { ...request.input, operation: { ...request.input.operation } },
		};
	if (request.kind === "redrive")
		return {
			kind: "redrive",
			input: { ...request.input, operation: { ...request.input.operation } },
		};
	if (request.kind === "extendLease")
		return {
			kind: "extendLease",
			input: { ...request.input, operation: { ...request.input.operation } },
		};
	return {
		kind: request.kind,
		input: { ...request.input, operation: { ...request.input.operation } },
	};
}

function cloneResult(result: QueueResult): QueueResult {
	if (result.status === "rejected")
		return { status: "rejected", code: result.code };
	const value = result.value;
	if (nativeArray(value)) {
		const deliveries: DurableQueueDelivery[] = [];
		for (let index = 0; index < value.length; index++)
			deliveries[index] = copyDelivery(value[index]);
		return { status: "committed", value: deliveries };
	}
	if ("body" in value)
		return { status: "committed", value: copyDelivery(value) };
	return { status: "committed", value: { ...value } };
}

function unknown(
	state: AtomicQueueState,
	operation: DurableQueueOperation,
): AtomicQueueTransition {
	return { state, outcome: { status: "unknown", operation }, changed: false };
}

export function transitionAtomicQueue(
	state: AtomicQueueState,
	request: AtomicQueueRequest,
	now: number,
	limits: DurableQueueLimits,
): AtomicQueueTransition {
	if (!nativeNumber(now) || now < 0)
		throw new TypeError("atomic_queue.invalid_clock");
	const op = request.input.operation;
	if (now >= op.expiresAtMs)
		return {
			state,
			outcome: { status: "expired", operation: op },
			changed: false,
		};
	const signature = fingerprint(request);
	let prior: AtomicQueueReceipt | undefined;
	for (let index = 0; index < state.receipts.length; index++) {
		const receipt = state.receipts[index];
		if (receipt?.id === op.id) {
			prior = receipt;
			break;
		}
	}
	if (prior !== undefined) {
		if (prior.fingerprint !== signature)
			return {
				state,
				outcome: { status: "rejected", code: "operation-conflict" },
				changed: false,
			};
		return { state, outcome: cloneResult(prior.result), changed: false };
	}
	const retained: AtomicQueueReceipt[] = [];
	for (let index = 0; index < state.receipts.length; index++) {
		const receipt = state.receipts[index];
		if (receipt !== undefined && receipt.expiresAtMs > now)
			retained[retained.length] = receipt;
	}
	if (retained.length >= limits.retainedReceipts) return unknown(state, op);
	let nextMessage = state.nextMessage;
	let nextLease = state.nextLease;
	const messages: AtomicQueueMessage[] = [];
	for (let index = 0; index < state.messages.length; index++) {
		const message = state.messages[index];
		if (message === undefined)
			throw new TypeError("atomic_queue.invalid_state");
		messages[index] = message;
	}
	let result: QueueResult;
	const rejected = (code: DurableQueueRejectionCode): QueueResult => ({
		status: "rejected",
		code,
	});
	if (op.expiresAtMs - now > limits.operationWindowMs)
		result = rejected("invalid-argument");
	else if (request.kind === "redrive" || request.kind === "confirmExport") {
		let index = -1;
		for (let position = 0; position < messages.length; position++)
			if (messages[position]?.messageId === request.input.messageId) {
				index = position;
				break;
			}
		const current = messages[index];
		let referenced = false;
		for (let position = 0; position < retained.length; position++) {
			const receipt = retained[position];
			if (receipt === undefined || receipt.result.status !== "committed")
				continue;
			const value = receipt.result.value;
			if (nativeArray(value)) {
				for (let item = 0; item < value.length; item++)
					if (value[item]?.messageId === request.input.messageId)
						referenced = true;
			} else if (
				"messageId" in value &&
				value.messageId === request.input.messageId
			)
				referenced = true;
		}
		if (
			!current ||
			current.completed ||
			current.deliveryAttempt < limits.deliveryAttempts ||
			(current.leaseId !== null && current.leaseExpiresAtMs > now) ||
			referenced
		)
			result = rejected("unavailable");
		else {
			messages[index] =
				request.kind === "confirmExport"
					? { ...current, completed: true, leaseId: null, leaseExpiresAtMs: 0 }
					: {
							...current,
							deliveryAttempt: 0,
							leaseId: null,
							leaseExpiresAtMs: 0,
							availableAtMs: now,
						};
			result = {
				status: "committed",
				value: {
					messageId: current.messageId,
					idempotencyKey: current.idempotencyKey,
				},
			};
		}
	} else if (request.kind === "enqueue") {
		const input = request.input.message;
		const sig = messageSignature(input);
		let existing: AtomicQueueMessage | undefined;
		for (let index = 0; index < messages.length; index++) {
			const candidate = messages[index];
			if (candidate?.idempotencyKey === input.idempotencyKey) {
				existing = candidate;
				break;
			}
		}
		if (existing !== undefined)
			result =
				existing.signature === sig
					? {
							status: "committed",
							value: {
								messageId: existing.messageId,
								idempotencyKey: existing.idempotencyKey,
							},
						}
					: rejected("message-conflict");
		else if (
			input.availableAtMs !== undefined &&
			input.availableAtMs > now &&
			input.availableAtMs - now > limits.delayMs
		)
			result = rejected("invalid-argument");
		else if (
			messages.length >= limits.retainedMessages ||
			nextMessage >= ATOMIC_QUEUE_MAX_SEQUENCE
		)
			result = rejected("capacity-exceeded");
		else {
			const message: AtomicQueueMessage = {
				messageId: `m${nextMessage++}`,
				signature: sig,
				idempotencyKey: input.idempotencyKey,
				body: new NativeBytes(input.body),
				attributes: copyAttributes(input.attributes),
				availableAtMs: input.availableAtMs ?? now,
				requestedAvailableAtMs: input.availableAtMs ?? null,
				deliveryAttempt: 0,
				leaseId: null,
				leaseExpiresAtMs: 0,
				completed: false,
			};
			messages[messages.length] = message;
			result = {
				status: "committed",
				value: {
					messageId: message.messageId,
					idempotencyKey: message.idempotencyKey,
				},
			};
		}
	} else if (request.kind === "dequeue") {
		const input = request.input;
		if (now > maxSafe - input.visibilityTimeoutMs)
			result = rejected("invalid-argument");
		else {
			const items: DurableQueueDelivery[] = [];
			let blocked: "delivery-exhausted" | "capacity-exceeded" | undefined;
			for (
				let index = 0;
				index < messages.length && items.length < input.maxMessages;
				index++
			) {
				const message = messages[index];
				if (
					message === undefined ||
					message.completed ||
					message.availableAtMs > now ||
					(message.leaseId !== null && message.leaseExpiresAtMs > now)
				)
					continue;
				if (message.deliveryAttempt >= limits.deliveryAttempts) {
					blocked = "delivery-exhausted";
					continue;
				}
				if (nextLease >= ATOMIC_QUEUE_MAX_SEQUENCE) {
					blocked = "capacity-exceeded";
					break;
				}
				const leased = {
					...message,
					leaseId: `l${nextLease++}`,
					leaseExpiresAtMs: now + input.visibilityTimeoutMs,
					deliveryAttempt: message.deliveryAttempt + 1,
				};
				messages[index] = leased;
				items[items.length] = delivery(leased);
			}
			result =
				items.length === 0 && blocked !== undefined
					? rejected(blocked)
					: { status: "committed", value: items };
		}
	} else {
		const input = request.input;
		let index = -1;
		for (let position = 0; position < messages.length; position++) {
			if (messages[position]?.messageId === input.messageId) {
				index = position;
				break;
			}
		}
		const current = messages[index];
		if (
			current === undefined ||
			current.completed ||
			current.leaseId !== input.leaseId ||
			current.leaseExpiresAtMs <= now
		)
			result = rejected("lease-lost");
		else if (request.kind === "extendLease") {
			if (now > maxSafe - request.input.visibilityTimeoutMs)
				result = rejected("invalid-argument");
			else {
				const extended = {
					...current,
					leaseExpiresAtMs: now + request.input.visibilityTimeoutMs,
				};
				messages[index] = extended;
				result = { status: "committed", value: delivery(extended) };
			}
		} else {
			messages[index] =
				request.kind === "complete"
					? { ...current, completed: true, leaseId: null, leaseExpiresAtMs: 0 }
					: {
							...current,
							availableAtMs: now,
							leaseId: null,
							leaseExpiresAtMs: 0,
						};
			result = {
				status: "committed",
				value: { messageId: input.messageId, leaseId: input.leaseId },
			};
		}
	}
	retained[retained.length] = {
		id: op.id,
		expiresAtMs: op.expiresAtMs,
		fingerprint: signature,
		request: copyRequest(request),
		result,
	};
	return {
		state: { nextMessage, nextLease, messages, receipts: retained },
		outcome: cloneResult(result),
		changed: true,
	};
}
