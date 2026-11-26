import { types } from "node:util";

// public-contract: stable identifier for the asynchronous cryptography port.
export const CRYPTOGRAPHY_CONTRACT = "hobo.cryptography/v1";
export const CRYPTOGRAPHY_MAX_INPUT_BYTES = 65_536;

export interface CryptographyRequest {
	readonly attemptId: string;
	readonly data: Uint8Array;
}

export type CryptographyOutcome =
	| {
			readonly status: "completed";
			readonly attemptId: string;
			readonly data: Uint8Array;
	  }
	| {
			readonly status: "rejected";
			readonly code: "invalid-argument" | "unauthorized" | "capacity";
	  }
	| { readonly status: "unknown"; readonly attemptId: string };

export interface CryptographyPort {
	encrypt(input: CryptographyRequest): Promise<CryptographyOutcome>;
	decrypt(input: CryptographyRequest): Promise<CryptographyOutcome>;
}

const isProxy = types.isProxy;
const isUint8Array = types.isUint8Array;
const isSharedArrayBuffer = types.isSharedArrayBuffer;
const ownKeys = Reflect.ownKeys;
const descriptor = Object.getOwnPropertyDescriptor;
const getPrototype = Object.getPrototypeOf;
const own = Object.hasOwn;
const create = Object.create;
const define = Object.defineProperty;
const freeze = Object.freeze;
const apply = Reflect.apply;
const exec = RegExp.prototype.exec;
const ByteArray = Uint8Array;
const typedArrayPrototype = getPrototype(Uint8Array.prototype);
const getBuffer = descriptor(typedArrayPrototype, "buffer")?.get;
const getByteLength = descriptor(typedArrayPrototype, "byteLength")?.get;
const attemptPattern = /^[A-Za-z0-9_-]{16,64}$/u;

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply -- SAFETY: requests and byte views cross an untrusted provider boundary. */
export function parseCryptographyRequest(value: unknown): CryptographyRequest {
	if (
		typeof value !== "object" ||
		value === null ||
		isProxy(value) ||
		(getPrototype(value) !== Object.prototype &&
			getPrototype(value) !== null) ||
		ownKeys(value).length !== 2
	)
		throw new TypeError("cryptography.invalid_request");
	const attempt = descriptor(value, "attemptId");
	const bytes = descriptor(value, "data");
	if (
		!attempt?.enumerable ||
		!own(attempt, "value") ||
		typeof attempt.value !== "string" ||
		apply(exec, attemptPattern, [attempt.value]) === null ||
		!bytes?.enumerable ||
		!own(bytes, "value") ||
		isProxy(bytes.value) ||
		!isUint8Array(bytes.value) ||
		getBuffer === undefined ||
		getByteLength === undefined
	)
		throw new TypeError("cryptography.invalid_request");
	let data: Uint8Array;
	try {
		const buffer = apply(getBuffer, bytes.value, []);
		const length = apply(getByteLength, bytes.value, []);
		if (
			isSharedArrayBuffer(buffer) ||
			length < 1 ||
			length > CRYPTOGRAPHY_MAX_INPUT_BYTES
		)
			throw new TypeError("cryptography.invalid_request");
		data = new ByteArray(bytes.value);
	} catch {
		throw new TypeError("cryptography.invalid_request");
	}
	// SAFETY: both own data properties are installed before the request is frozen.
	const result = create(null) as { attemptId: string; data: Uint8Array };
	const idField: PropertyDescriptor = create(null);
	idField.value = attempt.value;
	idField.enumerable = true;
	define(result, "attemptId", idField);
	const dataField: PropertyDescriptor = create(null);
	dataField.value = data;
	dataField.enumerable = true;
	define(result, "data", dataField);
	return freeze(result);
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply */
