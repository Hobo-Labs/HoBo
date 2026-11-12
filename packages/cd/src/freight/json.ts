// JSON guards for values that arrive already parsed (event bodies, JSON.parse
// output). They read the runtime tag, the same idiom @hobo/core uses, and
// establish the JSON contract the callers then decode against a schema.
import type { JsonObject, JsonValue } from "@bufbuild/protobuf";

const tagOf = Object.prototype.toString;

export function isJsonString<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

export function isJsonNumber<T>(value: T): value is T & number {
	return tagOf.call(value) === "[object Number]" && Number.isFinite(value);
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

/** A string member of a JSON object, or undefined. */
export function stringAt(value: JsonValue | undefined, key: string): string | undefined {
	if (!isJsonObject(value)) return undefined;
	const member = value[key];
	return isJsonString(member) ? member : undefined;
}

/** An object member of a JSON object, or undefined. */
export function objectAt(value: JsonValue | undefined, key: string): JsonObject | undefined {
	if (!isJsonObject(value)) return undefined;
	const member = value[key];
	return isJsonObject(member) ? member : undefined;
}
