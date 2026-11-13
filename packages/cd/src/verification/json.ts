// JSON guards for values that arrive as text (health-source answers) or as
// persisted event bodies. They read the runtime tag, the idiom @hobo/core uses
// internally, and establish the JSON contract callers then decode against.
import type { JsonObject, JsonValue } from "@bufbuild/protobuf";

const tagOf = Object.prototype.toString;

export function isJsonString<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

export function isJsonNumber<T>(value: T): value is T & number {
	return tagOf.call(value) === "[object Number]";
}

export function isJsonArray<T>(value: T): value is T & JsonValue[] {
	return Array.isArray(value);
}

/** A non-null, non-array plain object. */
export function isJsonObject<T>(value: T): value is T & JsonObject {
	return tagOf.call(value) === "[object Object]";
}

/** JSON text to a value, or undefined when it is not JSON. */
export function parseJsonText(text: string): JsonValue | undefined {
	try {
		const parsed: JsonValue = JSON.parse(text);
		return parsed;
	} catch {
		return undefined;
	}
}

/** A persisted event body as JSON (bodies are JSON by construction; anything else is undefined). */
export function jsonOf<T>(data: T): JsonValue | undefined {
	if (data === undefined) return undefined;
	try {
		return parseJsonText(JSON.stringify(data));
	} catch {
		return undefined;
	}
}
