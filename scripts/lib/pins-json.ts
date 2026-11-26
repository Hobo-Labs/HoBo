/**
 * The JSON readers behind the pins manifest parser (`pins.ts`): a value's kind
 * read from its tag, and the refusals every manifest field shares, each a
 * PINS_MALFORMED error naming where in the manifest it is.
 *
 * Erasable TypeScript with node builtins only.
 */
import { PinsError } from "./pins-error.ts";

export type Json =
	| null
	| boolean
	| number
	| string
	| readonly Json[]
	| JsonObject;
export interface JsonObject {
	readonly [key: string]: Json;
}

// The repo bans `typeof` for narrowing (anti-slop/no-runtime-typeof); a JSON
// value's kind is read from its tag instead, as in packages/cli/src/json.ts.
const tagOf = Object.prototype.toString;

export function isObject(value: Json | undefined): value is JsonObject {
	return (
		value !== undefined &&
		value !== null &&
		!Array.isArray(value) &&
		tagOf.call(value) === "[object Object]"
	);
}
export function isString(value: Json | undefined): value is string {
	return tagOf.call(value) === "[object String]";
}
export function isArray(value: Json | undefined): value is readonly Json[] {
	return Array.isArray(value);
}
export function isCount(value: Json | undefined): value is number {
	return (
		tagOf.call(value) === "[object Number]" &&
		Number.isInteger(value) &&
		Number(value) > 0
	);
}

export function malformed(where: string, message: string): never {
	throw new PinsError("PINS_MALFORMED", `${where}: ${message}`);
}

export function readObject(value: Json | undefined, where: string): JsonObject {
	return isObject(value) ? value : malformed(where, "must be an object");
}
export function readString(value: Json | undefined, where: string): string {
	return isString(value) && value !== ""
		? value
		: malformed(where, "must be a non-empty string");
}
export function readOnly(
	value: JsonObject,
	allowed: readonly string[],
	where: string,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) malformed(where, `unknown key "${key}"`);
	}
}

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: JSON.parse and Response.json land here; this function is the boundary that turns untrusted values into `Json`. */
export function parseUnknownJson(value: unknown): Json | undefined {
	if (value === null) return null;
	const kind = tagOf.call(value);
	if (
		kind === "[object Boolean]" ||
		kind === "[object Number]" ||
		kind === "[object String]"
	)
		// SAFETY: tag check matches a JSON primitive from an untrusted JSON decoder.
		return value as Json;
	if (kind === "[object Array]") {
		const items: Json[] = [];
		// SAFETY: tag check proves a real Array instance from an untrusted decoder.
		for (const entry of value as unknown[]) {
			const json = parseUnknownJson(entry);
			if (json === undefined) return undefined;
			items.push(json);
		}
		return items;
	}
	if (kind !== "[object Object]") return undefined;
	const entries: [string, Json][] = [];
	// SAFETY: tag check proves a plain object from an untrusted JSON decoder.
	for (const [key, entry] of Object.entries(value as object)) {
		const json = parseUnknownJson(entry);
		if (json === undefined) return undefined;
		entries.push([key, json]);
	}
	// SAFETY: every value was just parsed as `Json` and keyed by plain strings.
	return Object.fromEntries(entries) as JsonObject;
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion */

export function isNonNegativeInt(value: Json | undefined): value is number {
	return (
		tagOf.call(value) === "[object Number]" &&
		Number.isInteger(value) &&
		// SAFETY: `isInteger` already proved a number primitive.
		(value as number) >= 0
	);
}
