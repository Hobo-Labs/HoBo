import { type DescMessage, toJson } from "@bufbuild/protobuf";
import type { JsonValue } from "@hobo/core";
import type { FeedResponse, Refusal } from "../ports.js";
import { statusOf } from "./errors.js";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8";

export type WireValue =
	| JsonValue
	| bigint
	| undefined
	| readonly WireValue[]
	| { readonly [key: string]: WireValue };

const encoder = new TextEncoder();

export function recordJson<Desc extends DescMessage>(
	schema: Desc,
	record: Parameters<typeof toJson<Desc>>[1],
): JsonValue {
	return toJson(schema, record) as JsonValue;
}

function isBigInt(v: WireValue): v is bigint {
	return Object.prototype.toString.call(v) === "[object BigInt]";
}

export function stringify(value: WireValue): string {
	return JSON.stringify(value, (_key: string, v: WireValue) =>
		isBigInt(v) ? v.toString() : v,
	);
}

type ResponseHeaders = FeedResponse["headers"];

const NO_EXTRA_HEADERS: ResponseHeaders = Object.freeze({});

function headers(
	contentType: string,
	extra: ResponseHeaders = NO_EXTRA_HEADERS,
): ResponseHeaders {
	return { ...extra, "content-type": contentType, "cache-control": "no-store" };
}

export function okResponse(value: WireValue, status = 200): FeedResponse {
	return {
		status,
		headers: headers(JSON_CONTENT_TYPE),
		body: encoder.encode(stringify({ ok: true, value })),
	};
}

export function rawJsonResponse(document: WireValue): FeedResponse {
	return {
		status: 200,
		headers: headers(JSON_CONTENT_TYPE),
		body: encoder.encode(stringify(document)),
	};
}

export function refusalResponse(
	refusal: Refusal,
	extra: ResponseHeaders = NO_EXTRA_HEADERS,
): FeedResponse {
	return {
		status: statusOf(refusal),
		headers: headers(JSON_CONTENT_TYPE, extra),
		body: encoder.encode(
			stringify({
				ok: false,
				reasons: refusal.reasons.map((r) => ({
					code: r.code,
					message: r.message,
					remediation: r.remediation,
					subject: r.subject,
				})),
			}),
		),
	};
}

export function sseResponse(body: AsyncIterable<Uint8Array>): FeedResponse {
	return {
		status: 200,
		headers: {
			"content-type": SSE_CONTENT_TYPE,
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
		},
		body,
	};
}

export function encode(text: string): Uint8Array {
	return encoder.encode(text);
}
