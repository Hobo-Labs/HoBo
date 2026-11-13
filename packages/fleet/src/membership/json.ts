/**
 * JSON guards for journal data, without runtime `typeof` (the same tag check
 * as `@hobo/core`'s json.ts, which the core barrel does not export). Private
 * to the enrollment lane.
 */
import type { JsonValue as PbJsonValue } from "@bufbuild/protobuf";
import type { JsonObject, JsonValue } from "@hobo/core";

const tagOf = Object.prototype.toString;

/** A value the lane writes into event data. */
export type FieldValue = JsonValue;

export function isJsonString<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

export function isJsonNumber<T>(value: T): value is T & number {
	return tagOf.call(value) === "[object Number]";
}

export function isJsonArray<T>(value: T): value is T & JsonValue[] {
	return Array.isArray(value);
}

export function isJsonObject<T>(value: T): value is T & JsonObject {
	return (
		value !== undefined &&
		value !== null &&
		!Array.isArray(value) &&
		tagOf.call(value) === "[object Object]"
	);
}

/** Protobuf JSON as core JSON: the protobuf JSON value space (no bigint) is a subset of core's. */
export function pbJson(value: PbJsonValue): JsonValue {
	// SAFETY: @bufbuild/protobuf's JsonValue (null, boolean, number, string, arrays and objects of those) is assignable in kind to core's JsonValue; only the readonly modifiers differ.
	return value as JsonValue;
}
