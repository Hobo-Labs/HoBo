const tagOf = Object.prototype.toString;

export type JsonObject = Readonly<{ readonly [key: string]: JsonValue }>;
export interface JsonBag {
	[key: string]: JsonValue;
}
export interface StringBag {
	[key: string]: string;
}
/**
 * The JSON data model this package parses at its boundaries. Structurally
 * identical to `JsonValue` in `@hobo/camps` (readonly arrays and objects) so
 * parsed values flow between the two packages without a conversion step.
 */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| readonly JsonValue[]
	| JsonObject;

export function isJsonString<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

export function isJsonBigInt<T>(value: T): value is T & bigint {
	return tagOf.call(value) === "[object BigInt]";
}

export function isJsonNumber<T>(value: T): value is T & number {
	return tagOf.call(value) === "[object Number]";
}

export function isJsonBoolean<T>(value: T): value is T & boolean {
	return value === true || value === false;
}

export function isJsonObject<T>(value: T): value is T & JsonObject {
	return (
		value !== undefined &&
		value !== null &&
		!Array.isArray(value) &&
		tagOf.call(value) === "[object Object]"
	);
}

export function isJsonArray<T>(value: T): value is T & readonly JsonValue[] {
	return tagOf.call(value) === "[object Array]";
}

/** Clone a domain value across the JSON document boundary. */
export function cloneAsJson<T>(value: T): JsonValue {
	return parseJsonValue(JSON.stringify(value ?? null));
}

export function parseJsonObject(text: string): JsonObject {
	let value: JsonValue;
	try {
		// SAFETY: JSON.parse yields a JSON value at this document boundary.
		value = JSON.parse(text) as JsonValue;
	} catch {
		return {};
	}
	return isJsonObject(value) ? value : {};
}

export function asJsonObject<T>(value: T): JsonObject {
	const json = cloneAsJson(value);
	return isJsonObject(json) ? json : {};
}

export function parseJsonValue(text: string): JsonValue {
	try {
		// SAFETY: JSON.parse yields a JSON value at this document boundary.
		return JSON.parse(text) as JsonValue;
	} catch {
		return null;
	}
}
