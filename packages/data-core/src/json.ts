import { createHash } from "node:crypto";

const tagOf = Object.prototype.toString;

export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| readonly JsonValue[]
	| JsonObject;

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

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalEncode(value: JsonValue): string {
	if (isJsonArray(value)) {
		return `[${value.map((item) => canonicalEncode(item)).join(",")}]`;
	}
	if (isJsonObject(value)) {
		const keys = Object.keys(value).sort(compareCodeUnits);
		const members = keys.map(
			(key) => `${JSON.stringify(key)}:${canonicalEncode(value[key] ?? null)}`,
		);
		return `{${members.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export function digestOf(value: JsonValue): `sha256:${string}` {
	return `sha256:${sha256Hex(canonicalEncode(value))}`;
}

export function parseJsonText(text: string): JsonValue {
	// SAFETY: JSON.parse yields a JSON value at this document boundary.
	return JSON.parse(text) as JsonValue;
}

export function freezeDeep<T extends JsonValue>(value: T): T {
	if (isJsonArray(value)) {
		for (const item of value) freezeDeep(item);
		return Object.freeze(value);
	}
	if (isJsonObject(value)) {
		for (const key of Object.keys(value)) freezeDeep(value[key] ?? null);
		return Object.freeze(value);
	}
	return value;
}
