// JSON guards for values that arrive already parsed (wire bodies, event
// bodies, JWT segments). They read the runtime tag, the idiom @hobo/core
// uses, and establish the JSON contract callers then narrow further.
import type { JsonValue } from "@bufbuild/protobuf";

const tagOf = Object.prototype.toString;

export type WireObject = { [key: string]: JsonValue };

export function isText<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

export function isNumber<T>(value: T): value is T & number {
	return tagOf.call(value) === "[object Number]" && Number.isFinite(value);
}

export function isWireObject<T>(value: T): value is T & WireObject {
	return tagOf.call(value) === "[object Object]";
}

/** A non-empty string, or undefined. */
export function text(value: JsonValue | undefined): string | undefined {
	return isText(value) && value.length > 0 ? value : undefined;
}

/** String members of a JSON array (others dropped). */
export function texts(value: JsonValue | undefined): string[] {
	return Array.isArray(value)
		? value.filter((v): v is string => isText(v))
		: [];
}

/** Lower-cased header lookup without widening into an open dictionary. */
export function headerOf(
	headers: Readonly<Record<string, string>>,
	name: string,
): string | undefined {
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers))
		if (key.toLowerCase() === wanted) return value;
	return undefined;
}
