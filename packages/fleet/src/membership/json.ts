import type { JsonValue as PbJsonValue } from "@bufbuild/protobuf";
import type { JsonObject, JsonValue } from "@hobo/core";

const tagOf = Object.prototype.toString;

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

export function pbJson(value: PbJsonValue): JsonValue {
	return value;
}
