// JSON guards for @hobo/cd-gitops (tag-based, the repo's json.ts idiom).
import type { JsonObject, JsonValue } from "@hobo/core";

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
	return Array.isArray(value);
}

/** Clone any record across the JSON boundary (drops undefined, bigint-free). */
export function cloneAsJson<T>(value: T): JsonValue {
	// SAFETY: JSON.parse of JSON.stringify output is a JSON value.
	return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}
