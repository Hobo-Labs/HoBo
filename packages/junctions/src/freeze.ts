import { isJsonObject } from "./json.js";
export function deepFreeze<T>(value: T): T {
	if (value === null || value === undefined || Object.isFrozen(value)) {
		return value;
	}
	if (Array.isArray(value)) {
		for (const child of value) {
			deepFreeze(child);
		}
		return Object.freeze(value);
	}
	if (!isJsonObject(value)) {
		return value;
	}
	for (const child of Object.values(value)) {
		deepFreeze(child);
	}
	return Object.freeze(value);
}
