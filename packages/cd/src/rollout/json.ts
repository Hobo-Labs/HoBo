// JSON guards for persisted rollout ledger bodies and analysis-webhook answers.
// They read the runtime tag (the idiom @hobo/core uses) and establish the JSON
// contract that the parse functions in journal.ts then decode against.
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

/** The value as a JSON object, or undefined. */
export function objectOf(value: JsonValue | undefined): JsonObject | undefined {
	return isJsonObject(value) ? value : undefined;
}

export function text(value: JsonValue | undefined): string {
	return isJsonString(value) ? value : "";
}

export function num(value: JsonValue | undefined): number | undefined {
	return isJsonNumber(value) && Number.isFinite(value) ? value : undefined;
}

export function strings(value: JsonValue | undefined): readonly string[] {
	return isJsonArray(value) ? value.filter(isJsonString) : [];
}

/** Canonical JSON: object keys sorted, so digests never depend on insertion order. */
export function canonicalJson(value: JsonValue): string {
	if (isJsonArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isJsonObject(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys
			.filter((key) => value[key] !== undefined)
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
