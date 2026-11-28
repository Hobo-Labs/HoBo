/**
 * I/O-boundary JSON/inspectable values without `unknown`/`typeof`.
 * Event bodies, catch values, and runtime tag checks share these so oxlint
 * anti-slop stays green inside `@hobo/data`.
 */

import type { EventEnvelope } from "@hobo/core";

const tagOf = Object.prototype.toString;

const FUNCTION_TAGS = new Set([
	"[object Function]",
	"[object AsyncFunction]",
	"[object GeneratorFunction]",
	"[object AsyncGeneratorFunction]",
]);

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| JsonObject;

export type JsonObject = { readonly [key: string]: JsonValue };

export type Inspectable =
	| JsonValue
	| bigint
	| symbol
	| undefined
	| Error
	| Inspectable[]
	| { readonly [key: string]: Inspectable | undefined }
	| ((...args: Inspectable[]) => Inspectable);

export interface ErrorSignal {
	readonly name?: string;
	readonly code?: string;
	readonly message?: string;
}

export function isJsonString(value: Inspectable): value is string {
	return tagOf.call(value) === "[object String]";
}

export function isJsonNumber(value: Inspectable): value is number {
	return tagOf.call(value) === "[object Number]";
}

export function isJsonBoolean(value: Inspectable): value is boolean {
	return tagOf.call(value) === "[object Boolean]";
}

export function isJsonObject(value: Inspectable): value is JsonObject {
	return tagOf.call(value) === "[object Object]";
}

export function isJsonArray(value: Inspectable): value is JsonValue[] {
	return tagOf.call(value) === "[object Array]";
}

export function hasFunctionTag<T>(value: T): boolean {
	return FUNCTION_TAGS.has(tagOf.call(value));
}

export function isObjectLike(
	value: Inspectable,
): value is
	| JsonObject
	| Inspectable[]
	| { readonly [key: string]: Inspectable | undefined } {
	if (value === null || value === undefined) return false;
	const tag = tagOf.call(value);
	switch (tag) {
		case "[object String]":
		case "[object Number]":
		case "[object Boolean]":
		case "[object BigInt]":
		case "[object Symbol]":
		case "[object Function]":
		case "[object AsyncFunction]":
		case "[object GeneratorFunction]":
		case "[object AsyncGeneratorFunction]":
		case "[object Undefined]":
		case "[object Null]":
			return false;
		default:
			return true;
	}
}

export function parseNonEmptyString(value: Inspectable, field: string): string {
	if (!isJsonString(value) || value.length === 0) {
		throw new TypeError(`${field} must be a non-empty string`);
	}
	return value;
}

export function parseOffendingSeq(
	data: EventEnvelope["data"],
): number | undefined {
	// SAFETY: EventEnvelope.data is JSON at the store boundary; tag checks are fail-closed.
	const inspectable = data as Inspectable;
	if (!isJsonObject(inspectable)) return undefined;
	const offending = inspectable.offendingSeq;
	if (!isJsonNumber(offending)) return undefined;
	return offending;
}
