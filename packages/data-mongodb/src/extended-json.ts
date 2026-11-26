/**
 * The value language of the executor port: MongoDB Extended JSON v2 in
 * canonical mode.
 *
 * It is plain JSON, so a request or a document can be logged, diffed, put in a
 * pact, or sent over any transport, and it names every BSON type exactly:
 * `{ "$numberLong": "9007199254740993" }` is a 64-bit integer and can never be
 * mistaken for a double. A driver adapter converts with the driver's own
 * `EJSON.deserialize` / `EJSON.serialize`; this module only builds and reads
 * the wrappers, so the runtime needs no BSON library.
 */
import type { JsonObject, JsonValue } from "@hobo/data-core";
import {
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
} from "./json.js";

/** Any BSON value, as canonical Extended JSON. */
export type MongoValue = JsonValue;
/** A BSON document, as canonical Extended JSON. */
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

/** BSON type names as `$jsonSchema` spells them; `other` is everything else. */
export type MongoBsonType = (typeof MONGO_BSON_TYPES)[number];

/** Sorts before every other value: the open lower bound of a range. */
export const MONGO_MIN_KEY: MongoDocument = Object.freeze({ $minKey: 1 });
/** Sorts after every other value: the open upper bound of a range. */
export const MONGO_MAX_KEY: MongoDocument = Object.freeze({ $maxKey: 1 });

export function mongoLong(text: string): MongoDocument {
	return { $numberLong: text };
}

/** The text a driver prints for a double: integers keep a `.0`. */
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

/** The BSON type a canonical Extended JSON value denotes. */
export function mongoTypeOf(value: MongoValue): MongoBsonType {
	if (value === null) return "null";
	if (isJsonBoolean(value)) return "bool";
	if (isJsonString(value)) return "string";
	if (isJsonNumber(value)) {
		// A bare number is relaxed mode. A driver stores an integer as int32
		// when it fits, as int64 when that fits, and anything else as a double.
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

/** The string inside a one-key wrapper such as `{ "$numberLong": "5" }`. */
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
	/** Two lowercase hexadecimal digits. */
	readonly subType: string;
}

/** The payload of a `$binary` wrapper, or `undefined` when it is not one. */
export function binaryOf(value: MongoValue): MongoBinary | undefined {
	if (!isJsonObject(value)) return undefined;
	const inner = value.$binary;
	if (!isJsonObject(inner)) return undefined;
	const { base64, subType } = inner;
	if (!isJsonString(base64) || !isJsonString(subType)) return undefined;
	return { base64, subType: subType.toLowerCase().padStart(2, "0") };
}

/** Milliseconds since the epoch inside a `$date` wrapper, if it is exact. */
export function dateOf(value: MongoValue): number | undefined {
	if (!isJsonObject(value)) return undefined;
	const text = wrappedText(value.$date ?? null, "$numberLong");
	if (text === undefined || !/^-?[0-9]+$/u.test(text)) return undefined;
	const epochMs = Number(text);
	return Number.isSafeInteger(epochMs) ? epochMs : undefined;
}
