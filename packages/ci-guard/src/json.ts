
const objectTag = Object.prototype.toString;

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| JsonObject;

export interface JsonObject {
	[key: string]: JsonValue | undefined;
}

export function isJsonObject(
	value: JsonValue | undefined,
): value is JsonObject {
	return objectTag.call(value) === "[object Object]";
}

export function isJsonString(value: JsonValue | undefined): value is string {
	return objectTag.call(value) === "[object String]";
}

export function isJsonNumber(value: JsonValue | undefined): value is number {
	return objectTag.call(value) === "[object Number]";
}

export function parseJsonTree(raw: string): JsonValue {
	const parsed: JsonValue = JSON.parse(raw);
	return parsed;
}
