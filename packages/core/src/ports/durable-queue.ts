import { types } from "node:util";

// public-contract: stable identifier for the asynchronous durable queue port.
export const DURABLE_QUEUE_CONTRACT = "hobo.durable-queue/v1";
// public-contract: canonical queue component interface identifier.
export const DURABLE_QUEUE_WIT_INTERFACE = "hobo:queue/queue@0.1.0";

export const DURABLE_QUEUE_MAX_LIMITS = Object.freeze({
	nameBytes: 128,
	payloadBytes: 65_536,
	attributeCount: 32,
	attributeBytes: 8_192,
	batchSize: 100,
	delayMs: 86_400_000,
	leaseMs: 86_400_000,
	operationWindowMs: 86_400_000,
	deliveryAttempts: 100,
	retainedMessages: 10_000,
	retainedReceipts: 10_000,
});

export interface DurableQueueLimits {
	readonly nameBytes: number;
	readonly payloadBytes: number;
	readonly attributeCount: number;
	readonly attributeBytes: number;
	readonly batchSize: number;
	readonly delayMs: number;
	readonly leaseMs: number;
	readonly operationWindowMs: number;
	readonly deliveryAttempts: number;
	readonly retainedMessages: number;
	readonly retainedReceipts: number;
}

export interface DurableQueueOperation {
	readonly id: string;
	readonly expiresAtMs: number;
}
export type DurableQueueRejectionCode =
	| "invalid-argument"
	| "unauthorized"
	| "not-found"
	| "unsupported"
	| "operation-conflict"
	| "message-conflict"
	| "lease-lost"
	| "delivery-exhausted"
	| "capacity-exceeded"
	| "unavailable";

export type DurableQueueOutcome<T> =
	| { readonly status: "committed"; readonly value: T }
	| { readonly status: "rejected"; readonly code: DurableQueueRejectionCode }
	| { readonly status: "unknown"; readonly operation: DurableQueueOperation }
	| { readonly status: "expired"; readonly operation: DurableQueueOperation };

export interface DurableQueueMessage {
	readonly idempotencyKey: string;
	readonly body: Uint8Array;
	readonly attributes: readonly {
		readonly key: string;
		readonly value: string;
	}[];
	readonly availableAtMs?: number;
}

export interface DurableQueueEnqueueReceipt {
	readonly messageId: string;
	readonly idempotencyKey: string;
}

export interface DurableQueueDelivery {
	readonly messageId: string;
	readonly leaseId: string;
	readonly idempotencyKey: string;
	readonly body: Uint8Array;
	readonly attributes: readonly {
		readonly key: string;
		readonly value: string;
	}[];
	readonly leaseExpiresAtMs: number;
	readonly deliveryAttempt: number;
}

export interface DurableQueueSettlement {
	readonly operation: DurableQueueOperation;
	readonly messageId: string;
	readonly leaseId: string;
}

export interface DurableQueue {
	limits(): Promise<
		| { readonly status: "available"; readonly value: DurableQueueLimits }
		| { readonly status: "unavailable" }
	>;
	enqueue(input: {
		readonly operation: DurableQueueOperation;
		readonly message: DurableQueueMessage;
	}): Promise<DurableQueueOutcome<DurableQueueEnqueueReceipt>>;
	dequeue(input: {
		readonly operation: DurableQueueOperation;
		readonly maxMessages: number;
		readonly visibilityTimeoutMs: number;
	}): Promise<DurableQueueOutcome<readonly DurableQueueDelivery[]>>;
	complete(input: DurableQueueSettlement): Promise<
		DurableQueueOutcome<{
			readonly messageId: string;
			readonly leaseId: string;
		}>
	>;
	release(input: DurableQueueSettlement): Promise<
		DurableQueueOutcome<{
			readonly messageId: string;
			readonly leaseId: string;
		}>
	>;
	extendLease(
		input: DurableQueueSettlement & {
			readonly visibilityTimeoutMs: number;
		},
	): Promise<DurableQueueOutcome<DurableQueueDelivery>>;
}

const isProxy = types.isProxy;
const isArray = Array.isArray;
const getPrototype = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const descriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const isSafeInteger = Number.isSafeInteger;
const freeze = Object.freeze;
const create = Object.create;
const define = Object.defineProperty;
const objectPrototype = Object.prototype;
const apply = Reflect.apply;
const regexExec = RegExp.prototype.exec;
const nativeString = String;
const noncePattern = /^[A-Za-z0-9_-]{16,64}$/u;
const operationPattern = /^v1\.(0|[1-9][0-9]{0,15})\.([A-Za-z0-9_-]{16,64})$/u;
const limitNames = freeze([
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
] as const);

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply -- SAFETY: provider-declared limits and operation IDs cross an untrusted runtime boundary. */
export function durableQueueOperation(
	expiresAtMs: number,
	nonce: string,
): DurableQueueOperation {
	if (
		!isSafeInteger(expiresAtMs) ||
		expiresAtMs < 0 ||
		typeof nonce !== "string" ||
		apply(regexExec, noncePattern, [nonce]) === null
	)
		throw new TypeError("invalid durable queue operation");
	return freeze({ id: `v1.${expiresAtMs}.${nonce}`, expiresAtMs });
}

export function parseDurableQueueOperation(
	value: unknown,
): DurableQueueOperation {
	if (
		typeof value !== "object" ||
		value === null ||
		isProxy(value) ||
		isArray(value) ||
		(getPrototype(value) !== objectPrototype && getPrototype(value) !== null) ||
		ownKeys(value).length !== 2
	)
		throw new TypeError("invalid durable queue operation");
	const id = descriptor(value, "id");
	const expiry = descriptor(value, "expiresAtMs");
	if (
		id === undefined ||
		expiry === undefined ||
		!hasOwn(id, "value") ||
		!hasOwn(expiry, "value") ||
		!id.enumerable ||
		!expiry.enumerable ||
		typeof id.value !== "string" ||
		typeof expiry.value !== "number" ||
		!isSafeInteger(expiry.value) ||
		expiry.value < 0
	)
		throw new TypeError("invalid durable queue operation");
	const match = apply(regexExec, operationPattern, [id.value]);
	if (match === null || match[1] !== nativeString(expiry.value))
		throw new TypeError("invalid durable queue operation");
	return freeze({ id: id.value, expiresAtMs: expiry.value });
}

export function parseDurableQueueLimits(value: unknown): DurableQueueLimits {
	if (
		typeof value !== "object" ||
		value === null ||
		isProxy(value) ||
		isArray(value) ||
		(getPrototype(value) !== objectPrototype && getPrototype(value) !== null) ||
		ownKeys(value).length !== limitNames.length
	)
		throw new TypeError("invalid durable queue limits");
	const result: Partial<Record<(typeof limitNames)[number], number>> =
		create(null);
	for (let index = 0; index < limitNames.length; index++) {
		const name = limitNames[index];
		if (name === undefined) throw new TypeError("invalid durable queue limits");
		const field = descriptor(value, name);
		if (
			field === undefined ||
			!hasOwn(field, "value") ||
			!field.enumerable ||
			typeof field.value !== "number" ||
			!isSafeInteger(field.value) ||
			field.value <
				(name === "delayMs" ||
				name === "attributeCount" ||
				name === "attributeBytes"
					? 0
					: 1) ||
			field.value > DURABLE_QUEUE_MAX_LIMITS[name]
		)
			throw new TypeError("invalid durable queue limits");
		const property: PropertyDescriptor = create(null);
		property.value = field.value;
		property.enumerable = true;
		define(result, name, property);
	}
	if ((result.attributeCount === 0) !== (result.attributeBytes === 0))
		throw new TypeError("invalid durable queue limits");
	// SAFETY: the loop checked and copied every required own numeric limit.
	return freeze(result) as DurableQueueLimits;
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply */
