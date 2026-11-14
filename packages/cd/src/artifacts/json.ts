// JSON guards for registry responses, event bodies and trust policy. They read
// the runtime tag (the @hobo/core idiom) and never throw.
import type { JsonObject, JsonValue } from "@bufbuild/protobuf";

export type { JsonObject, JsonValue };

const tagOf = Object.prototype.toString;

export function isJsonString<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

export function isJsonNumber<T>(value: T): value is T & number {
	return tagOf.call(value) === "[object Number]" && Number.isFinite(value);
}

export function isJsonBoolean<T>(value: T): value is T & boolean {
	return tagOf.call(value) === "[object Boolean]";
}

export function isJsonArray<T>(value: T): value is T & JsonValue[] {
	return Array.isArray(value);
}

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

/** A persisted body as JSON (bodies are JSON by construction; anything else is undefined). */
export function jsonOf<T>(data: T): JsonValue | undefined {
	if (data === undefined) return undefined;
	try {
		return parseJsonText(JSON.stringify(data));
	} catch {
		return undefined;
	}
}

/**
 * The `code` (Node system errors, sigstore errors) or else the `name` of a
 * thrown value, for typed failure messages. Never the message: messages of
 * third-party errors can carry URLs or payload fragments.
 */
export function errorCodeOf<E>(error: E): string {
	if (!(error instanceof Error)) return "error";
	const code = Object.entries(error).find(([key]) => key === "code")?.[1];
	return isJsonString(code) && code !== "" ? code : error.name;
}

export function stringAt(object: JsonObject, key: string): string | undefined {
	const value = object[key];
	return isJsonString(value) ? value : undefined;
}

export function objectAt(
	object: JsonObject,
	key: string,
): JsonObject | undefined {
	const value = object[key];
	return isJsonObject(value) ? value : undefined;
}
