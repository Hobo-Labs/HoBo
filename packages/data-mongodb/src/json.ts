/**
 * Structural guards over JSON values.
 *
 * `@hobo/data-core` exports the JSON types but keeps its guards private, and
 * the repository lints out runtime `typeof`, so the handful this package needs
 * live here. They are tag checks, identical in meaning to data-core's own.
 */
import type { JsonObject, JsonValue } from "@hobo/data-core";

const tagOf = Object.prototype.toString;

export function isJsonString<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

export function isJsonNumber<T>(value: T): value is T & number {
	return tagOf.call(value) === "[object Number]";
}

export function isJsonBoolean<T>(value: T): value is T & boolean {
	return value === true || value === false;
}

export function isJsonArray<T>(value: T): value is T & readonly JsonValue[] {
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

/**
 * True when the text is well-formed Unicode. BSON strings are UTF-8, and an
 * unpaired surrogate has no UTF-8 encoding: a driver writes U+FFFD in its
 * place, which is a stored value that differs from the one given.
 */
export function isWellFormedText(text: string): boolean {
	return !/\p{Surrogate}/u.test(text);
}

/** Recursively freeze a JSON value in place and return it. */
export function freezeJson<T extends JsonValue>(value: T): T {
	if (isJsonArray(value)) {
		for (const item of value) freezeJson(item);
		return Object.freeze(value);
	}
	if (isJsonObject(value)) {
		for (const key of Object.keys(value)) freezeJson(value[key] ?? null);
		return Object.freeze(value);
	}
	return value;
}
