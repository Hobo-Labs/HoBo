// Shared HTTP helpers of the sign-in providers: bounded JSON requests, no
// redirects, https only. Private to this directory.
import type { JsonObject, JsonValue } from "@hobo/core";
import type { FleetFailure, Outcome } from "@hobo/fleet";

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 256 * 1024;
const tagOf = Object.prototype.toString;

export function isText(value: JsonValue | undefined): value is string {
	return tagOf.call(value) === "[object String]";
}
export function isRecord(value: JsonValue | undefined): value is JsonObject {
	return tagOf.call(value) === "[object Object]";
}

export function failed<T>(
	code: FleetFailure["code"],
	message: string,
): Outcome<T> {
	return { ok: false, error: { code, message } };
}

export type JsonAnswer = Readonly<{
	status: number;
	body: JsonValue | undefined;
	headers: Headers;
}>;

/** One request; the body is read up to 256 KiB and parsed as JSON when it is. */
export async function requestJson(
	fetcher: typeof fetch,
	url: string,
	init: Readonly<{
		method?: string;
		headers?: Readonly<Record<string, string>>;
		form?: Readonly<Record<string, string>>;
	}> = {},
): Promise<JsonAnswer> {
	if (!url.startsWith("https://"))
		throw new Error(`refusing a non-https provider URL ${url}`);
	const headers = new Headers(init.headers);
	headers.set("accept", "application/json");
	const request: RequestInit = {
		method: init.method ?? (init.form === undefined ? "GET" : "POST"),
		headers,
		redirect: "error",
		signal: AbortSignal.timeout(TIMEOUT_MS),
	};
	if (init.form !== undefined) {
		headers.set("content-type", "application/x-www-form-urlencoded");
		request.body = new URLSearchParams(init.form).toString();
	}
	const response = await fetcher(url, request);
	const text = await response.text();
	if (text.length > MAX_BYTES)
		throw new Error("the provider's answer is too large");
	let body: JsonValue | undefined;
	try {
		body = JSON.parse(text);
	} catch {
		body = undefined;
	}
	return { status: response.status, body, headers: response.headers };
}
