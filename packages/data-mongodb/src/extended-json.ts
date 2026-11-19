import type { JsonObject, JsonValue } from "@hobo/data-core";
import {
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
} from "./json.js";

export type MongoValue = JsonValue;
export type MongoDocument = JsonObject;

export const MONGO_BSON_TYPES = [
	"null",
	"bool",
	"string",
	"int",
	"long",
	"double",
	"decimal",
	"binData",
	"date",
	"array",
	"object",
	"minKey",
	"maxKey",
	"other",
] as const;

export type MongoBsonType = (typeof MONGO_BSON_TYPES)[number];

export const MONGO_MIN_KEY: MongoDocument = Object.freeze({ $minKey: 1 });
export const MONGO_MAX_KEY: MongoDocument = Object.freeze({ $maxKey: 1 });

export function mongoLong(text: string): MongoDocument {
	return { $numberLong: text };
}

export function doubleText(value: number): string {
	if (Object.is(value, -0)) return "-0.0";
	return Number.isInteger(value) && Math.abs(value) < 1e21
		? value.toFixed(1)
		: String(value);
}

export function mongoDouble(value: number): MongoDocument {
	return { $numberDouble: doubleText(value) };
}

export function mongoDecimal(text: string): MongoDocument {
	return { $numberDecimal: text };
}

export function mongoBinary(base64: string, subType: string): MongoDocument {
	return { $binary: { base64, subType } };
}

export function mongoDate(epochMs: number): MongoDocument {
	return { $date: { $numberLong: String(epochMs) } };
}

const WRAPPER_TYPES: ReadonlyMap<string, MongoBsonType> = new Map<
	string,
	MongoBsonType
>([
	["$numberInt", "int"],
	["$numberLong", "long"],
	["$numberDouble", "double"],
	["$numberDecimal", "decimal"],
	["$binary", "binData"],
	["$date", "date"],
	["$minKey", "minKey"],
	["$maxKey", "maxKey"],
]);

export function mongoTypeOf(value: MongoValue): MongoBsonType {
	if (value === null) return "null";
	if (isJsonBoolean(value)) return "bool";
	if (isJsonString(value)) return "string";
	if (isJsonNumber(value)) {
		if (!Number.isInteger(value) || Object.is(value, -0)) return "double";
		if (value >= -0x80000000 && value <= 0x7fffffff) return "int";
		return Math.abs(value) < 2 ** 63 ? "long" : "double";
	}
	if (isJsonArray(value)) return "array";
	const keys = Object.keys(value);
	if (!keys.some((key) => key.startsWith("$"))) return "object";
	const only = keys.length === 1 ? keys[0] : undefined;
	return (only === undefined ? undefined : WRAPPER_TYPES.get(only)) ?? "other";
}

export function wrappedText(
	value: MongoValue,
	wrapper: string,
): string | undefined {
	if (!isJsonObject(value)) return undefined;
	const inner = value[wrapper];
	return isJsonString(inner) ? inner : undefined;
}

export interface MongoBinary {
	readonly base64: string;
	readonly subType: string;
}

export function binaryOf(value: MongoValue): MongoBinary | undefined {
	if (!isJsonObject(value)) return undefined;
	const inner = value.$binary;
	if (!isJsonObject(inner)) return undefined;
	const { base64, subType } = inner;
	if (!isJsonString(base64) || !isJsonString(subType)) return undefined;
	return { base64, subType: subType.toLowerCase().padStart(2, "0") };
}

export function dateOf(value: MongoValue): number | undefined {
	if (!isJsonObject(value)) return undefined;
	const text = wrappedText(value.$date ?? null, "$numberLong");
	if (text === undefined || !/^-?[0-9]+$/u.test(text)) return undefined;
	const epochMs = Number(text);
	return Number.isSafeInteger(epochMs) ? epochMs : undefined;
}
