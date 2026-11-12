/**
 * Responses. Every answer is JSON, never cached, never sniffed; an error is
 * a `ConfigServiceError` whose message is HoBo's words, never a request body,
 * a token or a value.
 */
import type { JsonValue } from "./json.js";

const HEADERS = Object.freeze({
	"content-type": "application/json; charset=utf-8",
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
});

export function json(status: number, body: JsonValue): Response {
	return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

// public-contract: the error codes a client branches on (`ConfigServiceError.code`).
export const ERROR_CODES = [
	"NOT_FOUND",
	"METHOD_NOT_ALLOWED",
	"STORE_UNCONFIGURED",
	"UNAUTHENTICATED",
	"FORBIDDEN",
	"BOOTSTRAP_REFUSED",
	"BODY_REJECTED",
	"FOLDER_FULL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
	NOT_FOUND: 404,
	METHOD_NOT_ALLOWED: 405,
	STORE_UNCONFIGURED: 503,
	UNAUTHENTICATED: 401,
	FORBIDDEN: 403,
	BOOTSTRAP_REFUSED: 401,
	BODY_REJECTED: 400,
	FOLDER_FULL: 409,
});

const MESSAGES: Readonly<Record<ErrorCode, string>> = Object.freeze({
	NOT_FOUND: "no such route",
	METHOD_NOT_ALLOWED: "this route does not take that method",
	STORE_UNCONFIGURED:
		"the store's deploy-time binding is missing or invalid; it serves nothing until redeployed with one",
	UNAUTHENTICATED: "a valid token from a trusted issuer is required",
	FORBIDDEN: "this principal may not do that to this folder",
	BOOTSTRAP_REFUSED:
		"the bootstrap credential is wrong, expired or already used",
	BODY_REJECTED:
		"the body is too large, not UTF-8 JSON, or does not meet the record's constraints",
	FOLDER_FULL: "the folder would hold more entries than the store allows",
});

export function failure(code: ErrorCode): Response {
	return json(STATUS[code], { code, message: MESSAGES[code] });
}
