import type { JsonObject, JsonValue } from "@hobo/core";

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

export function parseJsonText(text: string): JsonValue | undefined {
	try {
		return JSON.parse(text) as JsonValue;
	} catch {
		return undefined;
	}
}

export function jsonField<T>(value: T, field: string): JsonValue | undefined {
	return isJsonObject(value) ? value[field] : undefined;
}

export function asError<T>(value: T): Error {
	return value instanceof Error ? value : new Error(String(value));
}
