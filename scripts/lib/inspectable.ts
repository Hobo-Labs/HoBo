/**
 * I/O-boundary values without using `unknown` or `object`, plus a typeof-free
 * kind probe. Used by repo scripts that must stay anti-slop clean.
 */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { readonly [key: string]: JsonValue };

export type Inspectable =
	| JsonValue
	| bigint
	| symbol
	| undefined
	| ((...args: JsonValue[]) => JsonValue);

export type RuntimeKind =
	| "string"
	| "number"
	| "boolean"
	| "bigint"
	| "symbol"
	| "function"
	| "object"
	| "undefined";

const objectTag = Object.prototype.toString;

export function runtimeKind(value: Inspectable): RuntimeKind {
	switch (objectTag.call(value)) {
		case "[object String]":
			return "string";
		case "[object Number]":
			return "number";
		case "[object Boolean]":
			return "boolean";
		case "[object BigInt]":
			return "bigint";
		case "[object Symbol]":
			return "symbol";
		case "[object Undefined]":
			return "undefined";
		case "[object Function]":
		case "[object AsyncFunction]":
		case "[object GeneratorFunction]":
		case "[object AsyncGeneratorFunction]":
			return "function";
		default:
			return "object";
	}
}
