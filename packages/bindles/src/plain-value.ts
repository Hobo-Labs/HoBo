
import { isJsonObject, isJsonString, type JsonObject } from "./json.js";

export function isRecord<T>(value: T): value is T & JsonObject {
	return isJsonObject(value) && !Array.isArray(value);
}

export function visitStrings<T>(
	value: T,
	path: string,
	visitor: (value: string, path: string) => void,
): void {
	if (isJsonString(value)) {
		visitor(value, path);
		return;
	}
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			visitStrings(item, `${path}[${index}]`, visitor);
		}
		return;
	}
	if (isRecord(value)) {
		for (const [key, child] of Object.entries(value)) {
			visitStrings(child, `${path}.${key}`, visitor);
		}
	}
}
