import type { JsonObject, JsonValue } from "@bufbuild/protobuf";

const tagOf = Object.prototype.toString;

export function isJsonString<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

export function isJsonArray<T>(value: T): value is T & JsonValue[] {
	return Array.isArray(value);
}

export function isJsonObject<T>(value: T): value is T & JsonObject {
	return tagOf.call(value) === "[object Object]";
}

export function jsonOf<T>(data: T): JsonValue | undefined {
	if (data === undefined) return undefined;
	try {
		const parsed: JsonValue = JSON.parse(JSON.stringify(data));
		return parsed;
	} catch {
		return undefined;
	}
}

export function stringAt(
	value: JsonValue | undefined,
	key: string,
): string | undefined {
	if (!isJsonObject(value)) return undefined;
	const member = value[key];
	return isJsonString(member) ? member : undefined;
}

export function objectAt(
	value: JsonValue | undefined,
	key: string,
): JsonObject | undefined {
	if (!isJsonObject(value)) return undefined;
	const member = value[key];
	return isJsonObject(member) ? member : undefined;
}
