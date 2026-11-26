import { createHash, Hash } from "node:crypto";
import { types as utilTypes } from "node:util";

const freeze = Object.freeze;
const descriptor = Object.getOwnPropertyDescriptor;
const getPrototype = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const isArray = Array.isArray;
const createNull = Object.create;
const defineProperty = Object.defineProperty;
const nativeString = String;
const setPrototype = Object.setPrototypeOf;
const stringify = JSON.stringify;
const arrayPrototype = Array.prototype;
const NativeUint8Array = Uint8Array;
const uint8Prototype = NativeUint8Array.prototype;
const NativeBuffer = Buffer;
const bufferPrototype = NativeBuffer.prototype;
const bufferFrom = NativeBuffer.from;
const bufferToString = bufferPrototype.toString;
const regexExec = RegExp.prototype.exec;
const trim = String.prototype.trim;
const hashUpdate = Hash.prototype.update;
const hashDigest = Hash.prototype.digest;

export const RIVET_ASYNC_KV_LIMITS = freeze({
	keyBytes: 1024,
	valueBytes: 32_768,
	entries: 4096,
	totalValueBytes: 16_777_216,
	requestBytes: 98_304,
	responseBytes: 98_304,
});

export const RIVET_ASYNC_KV_CAPABILITIES = freeze({
	get: true,
	set: true,
	delete: true,
	exists: true,
	compareAndSet: false,
	list: false,
	ttl: false,
	watch: false,
	durableIdempotency: false,
	automaticRetries: false,
	singleDispatchRequired: true,
	synchronousWit: false,
	bindleDependencies: false,
});

export type RivetAsyncKvOperation = "get" | "set" | "delete" | "exists";

const isProxy = utilTypes.isProxy;
const isUint8Array = utilTypes.isUint8Array;
const isSharedArrayBuffer = utilTypes.isSharedArrayBuffer;
const hasOwn = Object.hasOwn;
const apply = Reflect.apply;
const typedArray = getPrototype(uint8Prototype);
const getBuffer = descriptor(typedArray, "buffer")?.get;
const getLength = descriptor(typedArray, "byteLength")?.get;
const setBytes = typedArray.set;
const encoder = new TextEncoder();
const encode = TextEncoder.prototype.encode;

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- SAFETY: these values cross the public actor and client boundaries. */
export function kvKey(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= RIVET_ASYNC_KV_LIMITS.keyBytes &&
		apply(regexExec, /[\uD800-\uDFFF]/u, [value]) === null &&
		getLength !== undefined &&
		apply(getLength, apply(encode, encoder, [value]), []) <=
			RIVET_ASYNC_KV_LIMITS.keyBytes
	);
}

export function kvRequestId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		apply(
			regexExec,
			/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
			[value],
		) !== null
	);
}

export function kvDigest(value: unknown): value is string {
	return (
		typeof value === "string" &&
		apply(regexExec, /^sha256:[a-f0-9]{64}$/u, [value]) !== null
	);
}

export function kvActorName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		apply(trim, value, []) === value &&
		apply(regexExec, /[\p{Cc}\uD800-\uDFFF]/u, [value]) === null
	);
}

export function kvActorKey(value: unknown): readonly string[] | undefined {
	try {
		if (
			isProxy(value) ||
			!isArray(value) ||
			getPrototype(value) !== arrayPrototype ||
			value.length === 0 ||
			value.length > 16 ||
			ownKeys(value).length !== value.length + 1
		)
			return undefined;
		const result: string[] = [];
		for (let index = 0; index < value.length; index++) {
			const entry = descriptor(value, nativeString(index));
			if (
				!entry?.enumerable ||
				!hasOwn(entry, "value") ||
				!kvActorName(entry.value)
			)
				return undefined;
			const property: PropertyDescriptor = createNull(null);
			property.value = entry.value;
			property.enumerable = true;
			property.configurable = true;
			property.writable = true;
			defineProperty(result, nativeString(index), freeze(property));
		}
		return freeze(result);
	} catch {
		return undefined;
	}
}

export function kvBytes(
	value: unknown,
	maximum: number,
): Uint8Array | undefined {
	try {
		if (
			isProxy(value) ||
			!isUint8Array(value) ||
			(getPrototype(value) !== uint8Prototype &&
				getPrototype(value) !== bufferPrototype) ||
			getBuffer === undefined ||
			getLength === undefined
		)
			return undefined;
		const buffer = apply(getBuffer, value, []);
		const length = apply(getLength, value, []);
		if (
			isSharedArrayBuffer(buffer) ||
			typeof length !== "number" ||
			length > maximum
		)
			return undefined;
		const copy = new NativeUint8Array(length);
		apply(setBytes, copy, [value]);
		return copy;
	} catch {
		return undefined;
	}
}

export function kvValue(value: unknown): Uint8Array | undefined {
	return kvBytes(value, RIVET_ASYNC_KV_LIMITS.valueBytes);
}

export function kvDecode(value: unknown): Uint8Array | undefined {
	if (
		typeof value !== "string" ||
		value.length > 43_692 ||
		apply(
			regexExec,
			/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
			[value],
		) === null
	)
		return undefined;
	const bytes = apply(bufferFrom, NativeBuffer, [value, "base64"]);
	if (
		getLength === undefined ||
		apply(getLength, bytes, []) > RIVET_ASYNC_KV_LIMITS.valueBytes ||
		apply(bufferToString, bytes, ["base64"]) !== value
	)
		return undefined;
	return kvBytes(bytes, RIVET_ASYNC_KV_LIMITS.valueBytes);
}

export function kvFingerprint(
	semanticDigest: string,
	operation: RivetAsyncKvOperation,
	requestId: string,
	key: string,
	encoded?: string,
): string {
	const fields = [
		"hobo-rivet-kv/v1",
		semanticDigest,
		operation,
		requestId,
		key,
		encoded ?? null,
	];
	setPrototype(fields, null);
	const hash = createHash("sha256");
	apply(hashUpdate, hash, [stringify(fields)]);
	return `sha256:${apply(hashDigest, hash, ["hex"])}`;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns */
