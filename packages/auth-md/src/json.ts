/** JSON values accepted at the bounded auth.md HTTP wire boundary. */
import { authMdError } from "./errors.js";

export type AuthMdJsonValue =
	| null
	| string
	| number
	| boolean
	| AuthMdJsonValue[]
	| { readonly [key: string]: AuthMdJsonValue };
export type AuthMdJsonObject = { readonly [key: string]: AuthMdJsonValue };

export function parseAuthMdJson(text: string): AuthMdJsonValue {
	// SAFETY: JSON.parse establishes JSON syntax; domain parsers validate individual fields.
	return JSON.parse(text) as AuthMdJsonValue;
}
export function authMdJsonObject<T>(value: T, label: string): AuthMdJsonObject {
	if (Object.prototype.toString.call(value) !== "[object Object]")
		throw authMdError(
			"AUTHMD_METADATA_INVALID",
			`${label} must be a JSON object`,
		);
	// SAFETY: the JSON object boundary is checked here; field parsers validate its contents.
	return value as AuthMdJsonObject;
}
export function authMdJsonString<T>(value: T): value is T & string {
	return Object.prototype.toString.call(value) === "[object String]";
}
