import type { JsonObject, JsonValue } from "@hobo/core";

/**
 * Representation guards for values crossing an I/O boundary (driver rows,
 * caller input). Tag-based, like `@hobo/core`'s own JSON guards, so boxed
 * and cross-realm values classify the same way.
 */
const tagOf = Object.prototype.toString;

export function isJsonString<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

export function isJsonNumber<T>(value: T): value is T & number {
	return tagOf.call(value) === "[object Number]";
}

export function isJsonBigInt<T>(value: T): value is T & bigint {
	return tagOf.call(value) === "[object BigInt]";
}

export function isJsonObject<T>(value: T): value is T & JsonObject {
	return (
		value !== undefined &&
		value !== null &&
		!Array.isArray(value) &&
		tagOf.call(value) === "[object Object]"
	);
}

/** Parse JSON text; `undefined` when it is not valid JSON. */
export function parseJsonText(text: string): JsonValue | undefined {
	try {
		// SAFETY: JSON.parse returns a JSON value for valid JSON text.
		return JSON.parse(text) as JsonValue;
	} catch {
		return undefined;
	}
}

/** One field of a JSON object, if the value is an object. */
export function jsonField<T>(value: T, field: string): JsonValue | undefined {
	return isJsonObject(value) ? value[field] : undefined;
}

/** Normalise any thrown value into an Error. */
export function asError<T>(value: T): Error {
	return value instanceof Error ? value : new Error(String(value));
}
