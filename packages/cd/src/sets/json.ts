// JSON document helpers for the desired-state parse boundaries. Guards are
// tag-based (never `typeof`) and generic, so callers keep their evidence.
import type { JsonObject, JsonValue } from "@hobo/core";

const tagOf = Object.prototype.toString;

export function isJsonObject<T>(value: T): value is T & JsonObject {
	return (
		value !== null &&
		value !== undefined &&
		!Array.isArray(value) &&
		tagOf.call(value) === "[object Object]"
	);
}

export function isText<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

export function isTextList<T>(value: T): value is T & string[] {
	return Array.isArray(value) && value.every((item) => isText(item));
}

export function isFlag<T>(value: T): value is T & boolean {
	return value === true || value === false;
}

export function isNumber<T>(value: T): value is T & number {
	return tagOf.call(value) === "[object Number]";
}

/** Cross a value over the JSON document boundary (drops undefined, rejects bigint). */
export function toJsonValue<T>(value: T): JsonValue {
	// SAFETY: JSON.parse of JSON.stringify output is a JSON value by construction.
	return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

/** A member of a JSON object, or undefined when the value is not an object. */
export function member<T>(value: T, key: string): JsonValue | undefined {
	return isJsonObject(value) ? value[key] : undefined;
}

/** A non-empty string member, or undefined. */
export function textMember<T>(value: T, key: string): string | undefined {
	const found = member(value, key);
	return isText(found) && found !== "" ? found : undefined;
}

/** Key-sorted at every depth (arrays keep their order); code-unit order, locale-free. */
export function sortDeep(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(sortDeep);
	if (isJsonObject(value)) {
		const out: Record<string, JsonValue> = {};
		for (const key of Object.keys(value).sort()) {
			const child = value[key];
			if (child !== undefined) out[key] = sortDeep(child);
		}
		return out;
	}
	return value;
}

/** Deterministic compact JSON: sorted keys at every depth. */
export function canonicalJson<T>(value: T): string {
	return JSON.stringify(sortDeep(toJsonValue(value)));
}
