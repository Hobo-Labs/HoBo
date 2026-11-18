import { types } from "node:util";
import {
	isJsonBoolean,
	isJsonNumber,
	isJsonString,
	type JsonValue,
} from "../json.js";
import { ReplayParseError } from "./parse.js";

/** Snapshot ordinary JSON data without invoking accessors or proxy traps. */
export function captureProtoJson(raw: JsonValue): JsonValue {
	return copyJson(raw, new Set(), 0);
}

function copyJson(
	value: JsonValue,
	active: Set<object>,
	depth: number,
): JsonValue {
	if (depth > 100)
		throw new ReplayParseError("protobuf JSON nesting limit exceeded");
	if (value === null) return null;
	const object: object = Object(value);
	if (object !== value) {
		if (isJsonString(value) || isJsonBoolean(value)) return value;
		if (isJsonNumber(value) && Number.isFinite(value)) return value;
		throw new ReplayParseError("protobuf JSON must contain finite JSON values");
	}
	if (types.isProxy(object) || active.has(object))
		throw new ReplayParseError(
			"protobuf JSON cannot contain proxies or cycles",
		);
	const array = Array.isArray(value);
	const prototype = Object.getPrototypeOf(object);
	if (
		(array
			? prototype !== Array.prototype
			: prototype !== Object.prototype && prototype !== null) ||
		Object.getOwnPropertySymbols(object).length !== 0
	)
		throw new ReplayParseError("protobuf JSON must contain ordinary data");
	const names = Object.getOwnPropertyNames(object);
	if (array && names.length !== value.length + 1)
		throw new ReplayParseError("protobuf JSON arrays must be dense");
	active.add(object);
	try {
		const entries: [string, JsonValue][] = [];
		for (const name of names) {
			const descriptor = Object.getOwnPropertyDescriptor(object, name);
			if (!descriptor || !("value" in descriptor))
				throw new ReplayParseError("protobuf JSON cannot contain accessors");
			if (array && name === "length") continue;
			if (!descriptor.enumerable)
				throw new ReplayParseError("protobuf JSON fields must be enumerable");
			if (array) {
				const index = Number(name);
				if (
					!Number.isSafeInteger(index) ||
					index < 0 ||
					index >= value.length ||
					String(index) !== name
				)
					throw new ReplayParseError("protobuf JSON arrays must be dense");
			}
			entries.push([name, copyJson(descriptor.value, active, depth + 1)]);
		}
		if (array) {
			const result: JsonValue[] = [];
			for (const [, entry] of entries) result.push(entry);
			return result;
		}
		return Object.fromEntries(entries);
	} finally {
		active.delete(object);
	}
}
