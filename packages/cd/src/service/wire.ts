// Wire helpers for the CD read API (WP12). Records leave as canonical
// protobuf JSON (`toJson` over the generated schemas: camelCase fields, enum
// names, 64-bit integers as strings), wrapped in the same envelope the
// delivery feed uses: `{ok: true, value}` or `{ok: false, reasons}`.
import {
	type DescMessage,
	type MessageShape,
	toJson,
} from "@bufbuild/protobuf";
import type { JsonValue } from "@hobo/core";
import type { FeedResponse, Refusal } from "../ports.js";
import { statusOf } from "./errors.js";

export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
export const SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8";

const encoder = new TextEncoder();

/** Protobuf record → canonical JSON. */
export function recordJson<Desc extends DescMessage>(
	schema: Desc,
	record: MessageShape<Desc>,
): JsonValue {
	return toJson(schema, record) as JsonValue;
}

/** JSON.stringify that keeps 64-bit integers exact (as decimal strings). */
export function stringify(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) =>
		isBigInt(v) ? v.toString() : v,
	);
}

function isBigInt(v: unknown): v is bigint {
	return Object.prototype.toString.call(v) === "[object BigInt]";
}

function headers(
	contentType: string,
	extra: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
	return { "content-type": contentType, "cache-control": "no-store", ...extra };
}

export function okResponse(value: unknown, status = 200): FeedResponse {
	return {
		status,
		headers: headers(JSON_CONTENT_TYPE),
		body: encoder.encode(stringify({ ok: true, value })),
	};
}

export function rawJsonResponse(document: unknown): FeedResponse {
	return {
		status: 200,
		headers: headers(JSON_CONTENT_TYPE),
		body: encoder.encode(stringify(document)),
	};
}

export function refusalResponse(
	refusal: Refusal,
	extra: Readonly<Record<string, string>> = {},
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
