import type { JsonValue as PbJsonValue } from "@bufbuild/protobuf";
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

export function pbJson(value: PbJsonValue): JsonValue {
	return value;
}

export function objectOf<T>(value: T): JsonObject {
	return isJsonObject(value) ? value : {};
}

export function textOf(data: JsonObject, field: string): string {
	const value = data[field];
	return isJsonString(value) ? value : "";
}

export function numberOf(data: JsonObject, field: string): number {
	const value = data[field];
	return isJsonNumber(value) ? value : 0;
}
