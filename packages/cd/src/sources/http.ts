// One outbound read for every driver: bounded time and size, no redirects
// (the HttpTransport contract), and every non-success mapped to a typed
// refusal. Rate limits (429, 503 with Retry-After, GitHub-style 403 with an
// exhausted quota) become `source-rate-limited` with the server's delay so the
// source backs off instead of hammering the registry.
import type { HttpTransport, TransportMethod, TransportResponse } from "@hobo/core";
import type { Outcome } from "../ports.js";
import { latin1Bytes } from "./json.js";
import { rateLimited, refuse, SOURCE_REASON } from "./reasons.js";

export const SOURCE_HTTP_TIMEOUT_MS = 30_000;
export const SOURCE_HTTP_MAX_BYTES = 8 * 1024 * 1024;
/** Upper bound for a package body hashed when the registry publishes no sha256. */
export const SOURCE_HTTP_MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

export type SourceRequest = Readonly<{
	method?: TransportMethod;
	url: string;
	headers?: Readonly<Record<string, string>>;
	body?: string;
	maxResponseBytes?: number;
	/** Statuses the caller handles itself (returned as ok). */
	accept?: readonly number[];
}>;

export function header(response: TransportResponse, name: string): string | undefined {
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(response.headers)) {
		if (key.toLowerCase() === wanted) return value;
	}
	return undefined;
}

function retryAfter(response: TransportResponse, nowMs: number): number {
	const value = header(response, "retry-after");
	if (value !== undefined) {
		if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
		const at = Date.parse(value);
		if (!Number.isNaN(at)) return Math.max(0, at - nowMs);
	}
	const reset = header(response, "x-ratelimit-reset");
	if (reset !== undefined && /^\d+$/.test(reset.trim())) {
		return Math.max(0, Number(reset.trim()) * 1000 - nowMs);
	}
	return 0;
}

function isRateLimit(response: TransportResponse): boolean {
	if (response.status === 429) return true;
	if (response.status === 503 && header(response, "retry-after") !== undefined) return true;
	return response.status === 403 && header(response, "x-ratelimit-remaining") === "0";
}

/** Strip query and userinfo before a URL lands in a reason (records are secret-free). */
export function redactUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
	} catch {
		return "<invalid url>";
	}
}

export async function fetchSource(
	http: HttpTransport,
	request: SourceRequest,
	nowMs: number,
): Promise<Outcome<TransportResponse>> {
	const where = redactUrl(request.url);
	if (!request.url.startsWith("https://")) {
		return refuse(
			SOURCE_REASON.invalid,
			`${where} is not an https URL`,
			"sources read over HTTPS only; fix the subscription locator",
			where,
		);
	}
	let response: TransportResponse;
	try {
		const outbound = {
			method: request.method ?? "GET",
			url: request.url,
			headers: request.headers ?? {},
			timeoutMs: SOURCE_HTTP_TIMEOUT_MS,
			maxResponseBytes: request.maxResponseBytes ?? SOURCE_HTTP_MAX_BYTES,
		};
		response = await http(request.body === undefined ? outbound : { ...outbound, body: request.body });
	} catch (error) {
		return refuse(
			SOURCE_REASON.unreachable,
			`${where} could not be read: ${error instanceof Error ? error.message : "transport failure"}`,
			"check network reachability and the host allowlist; the source retries with backoff",
			where,
		);
	}
	if (request.accept?.includes(response.status)) return { ok: true, value: response };
	if (isRateLimit(response)) return rateLimited(where, retryAfter(response, nowMs));
	if (response.status >= 200 && response.status < 300) return { ok: true, value: response };
	if (response.status === 401 || response.status === 403) {
		return refuse(
			SOURCE_REASON.authFailed,
			`${where} refused the read (${response.status})`,
			"set or rotate the subscription credentialRef; check the credential's scope",
			where,
		);
	}
	if (response.status === 404) {
		return refuse(
			SOURCE_REASON.notFound,
			`${where} does not exist (404)`,
			"fix the subscription locator, or grant the credential read access",
			where,
		);
	}
	return refuse(
		SOURCE_REASON.unreachable,
		`${where} answered ${response.status}`,
		"the source retries with backoff; check the upstream service status",
		where,
	);
}

/** Decode a binary body; refuses a transport that is not byte-transparent. */
export function bodyBytes(response: TransportResponse, where: string): Outcome<Uint8Array> {
	const bytes = latin1Bytes(response.body);
	if (bytes) return { ok: true, value: bytes };
	return refuse(
		SOURCE_REASON.transportNotBinarySafe,
		`${where} returned a body that is not byte-transparent`,
		"configure the HttpTransport to return binary bodies as latin1 (one char per byte)",
		where,
	);
}

export function upstreamInvalid(where: string, message: string) {
	return refuse(
		SOURCE_REASON.upstreamInvalid,
		`${where}: ${message}`,
		"the upstream answered an unexpected document; check the locator points at the right service",
		where,
	);
}
