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

export function isWellFormedText(text: string): boolean {
	return !/\p{Surrogate}/u.test(text);
}

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
