import type { JsonObject, JsonValue } from "@hobo/core";

export type { JsonObject, JsonValue };

const tagOf = Object.prototype.toString;

export function isJsonString<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

export function isJsonNumber<T>(value: T): value is T & number {
	return tagOf.call(value) === "[object Number]";
}

export function isJsonObject<T>(value: T): value is T & JsonObject {
	return (
		value !== undefined &&
		value !== null &&
		!Array.isArray(value) &&
		tagOf.call(value) === "[object Object]"
	);
}

export function isJsonArray<T>(value: T): value is T & JsonValue[] {
	return tagOf.call(value) === "[object Array]";
}

export function parseJsonText(text: string): JsonValue {
	return JSON.parse(text) as JsonValue;
}
