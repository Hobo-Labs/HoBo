// JSON guards for @hobo/cd-kube-fleet (tag-based, the repo's json.ts idiom).
// Kubernetes responses cross this package's boundary as untyped JSON; these
// guards are the only way a parser reads them.
import type { JsonObject, JsonValue } from "@hobo/core";

const tagOf = Object.prototype.toString;

export function isJsonString<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

export function isJsonNumber<T>(value: T): value is T & number {
	return tagOf.call(value) === "[object Number]";
}

export function isJsonBoolean<T>(value: T): value is T & boolean {
	return tagOf.call(value) === "[object Boolean]";
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

/** The object at `key`, or an empty object. */
export function objectAt(value: JsonValue | undefined, key: string): JsonObject {
	if (!isJsonObject(value)) return {};
	const child = value[key];
	return isJsonObject(child) ? child : {};
}

/** The array at `key`, or an empty array. */
export function arrayAt(
	value: JsonValue | undefined,
	key: string,
): readonly JsonValue[] {
	if (!isJsonObject(value)) return [];
	const child = value[key];
	return isJsonArray(child) ? child : [];
}

/** The JSON objects of an array, in order (other entries dropped). */
export function objectsOf(values: readonly JsonValue[]): JsonObject[] {
	const out: JsonObject[] = [];
	for (const value of values) if (isJsonObject(value)) out.push(value);
	return out;
}

/** The string at `key`, or undefined. */
export function stringAt(
	value: JsonValue | undefined,
	key: string,
): string | undefined {
	if (!isJsonObject(value)) return undefined;
	const child = value[key];
	return isJsonString(child) ? child : undefined;
}

/** The number at `key`, or undefined. */
export function numberAt(
	value: JsonValue | undefined,
	key: string,
): number | undefined {
	if (!isJsonObject(value)) return undefined;
	const child = value[key];
	return isJsonNumber(child) ? child : undefined;
}

/** The value at a dotted path (`status.readyReplicas`), or undefined. */
export function valueAtPath(
	value: JsonValue | undefined,
	path: string,
): JsonValue | undefined {
	let cursor: JsonValue | undefined = value;
	for (const key of path.split(".")) {
		if (!isJsonObject(cursor)) return undefined;
		cursor = cursor[key];
	}
	return cursor;
}

/** Clone any record across the JSON boundary (drops undefined, bigint-free). */
export function cloneAsJson<T>(value: T): JsonValue {
	// SAFETY: JSON.parse of JSON.stringify output is a JSON value.
	return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

/** Parse a response body; undefined when it is not JSON. */
export function parseJsonText(text: string): JsonValue | undefined {
	try {
		// SAFETY: JSON.parse yields a JSON value at this response boundary.
		return JSON.parse(text) as JsonValue;
	} catch {
		return undefined;
	}
}
