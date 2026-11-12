/**
 * JSON values at the Worker's boundary: what `JSON.parse` yields, narrowed
 * by tag, never by `typeof`. Web platform only.
 */
const tagOf = Object.prototype.toString;

export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| readonly JsonValue[]
	| JsonObject;

export function isJsonString(value: JsonValue | undefined): value is string {
	return tagOf.call(value) === "[object String]";
}

export function isJsonNumber(value: JsonValue | undefined): value is number {
	return tagOf.call(value) === "[object Number]";
}

export function isJsonArray(
	value: JsonValue | undefined,
): value is readonly JsonValue[] {
	return Array.isArray(value);
}

export function isJsonObject(
	value: JsonValue | undefined,
): value is JsonObject {
	return (
		value !== undefined &&
		value !== null &&
		!Array.isArray(value) &&
		tagOf.call(value) === "[object Object]"
	);
}

/** The parsed text, or undefined when it is empty or not JSON. */
export function parseJson(text: string | undefined): JsonValue | undefined {
	if (text === undefined || text === "") return undefined;
	try {
		// SAFETY: JSON.parse yields a JSON value at this document boundary.
		return JSON.parse(text) as JsonValue;
	} catch {
		return undefined;
	}
}

export function jsonObject(text: string | undefined): JsonObject | undefined {
	const value = parseJson(text);
	return isJsonObject(value) ? value : undefined;
}

export function field(
	source: JsonObject | undefined,
	key: string,
): JsonValue | undefined {
	return source !== undefined && Object.hasOwn(source, key)
		? source[key]
		: undefined;
}

/** `source[key]` when it is a string matching `pattern`. */
export function matching(
	source: JsonObject | undefined,
	key: string,
	pattern: RegExp,
): string | undefined {
	const value = field(source, key);
	return isJsonString(value) && pattern.test(value) ? value : undefined;
}
