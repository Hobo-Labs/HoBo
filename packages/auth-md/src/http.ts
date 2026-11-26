/**
 * The single outbound HTTP boundary of this package.
 *
 * `fetch` is always injected (`fetchImpl`): production paths never reach for
 * the global. Every request is HTTPS-only, byte-bounded, deadline-bounded, and
 * refuses a redirect that leaves the original host — an agent following a
 * cross-host redirect during discovery is how a pre-claim credential ends up
 * presented to somebody else's service.
 */
import { authMdError } from "./errors.js";
import { type AuthMdJsonValue, parseAuthMdJson } from "./json.js";
import type { HttpsUrl } from "./types.js";
import { parseHttpsUrl } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
export const MAX_SAME_HOST_REDIRECTS = 3;

/** Injected HTTP port. Nothing in this package closes over global fetch. */
export interface HttpPort {
	readonly fetchImpl: typeof fetch;
	readonly timeoutMs?: number;
	readonly maxResponseBytes?: number;
}

export interface HttpResponseView {
	readonly url: HttpsUrl;
	readonly status: number;
	readonly contentType: string | undefined;
	readonly body: string;
}

export interface HttpRequestOptions {
	readonly method?: "GET" | "POST";
	readonly accept?: string;
	readonly jsonBody?: unknown;
	readonly formBody?: Readonly<Record<string, string>>;
	readonly rejectRedirects?: boolean;
	readonly headers?: Readonly<Record<string, string>>;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function requestBounded(
	port: HttpPort,
	target: string,
	options: HttpRequestOptions = {},
): Promise<HttpResponseView> {
	const maxBytes = port.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
	const timeoutMs = port.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const originalUrl = parseHttpsUrl(target, "requestUrl");
	const originalHost = new URL(originalUrl).host;

	let currentUrl = originalUrl;
	for (let hop = 0; hop <= MAX_SAME_HOST_REDIRECTS; hop += 1) {
		const { response, body } = await fetchOnce(
			port,
			currentUrl,
			timeoutMs,
			maxBytes,
			options,
		);

		if (REDIRECT_STATUSES.has(response.status)) {
			if (options.rejectRedirects)
				throw authMdError(
					"AUTHMD_DISCOVERY_FAILED",
					"credential-bearing request refused a redirect",
					{ url: currentUrl },
				);
			currentUrl = nextRedirectTarget(response, currentUrl, originalHost);
			continue;
		}

		if (response.status < 200 || response.status >= 300) {
			throw authMdError(
				"AUTHMD_DISCOVERY_FAILED",
				`request to ${currentUrl} returned HTTP ${response.status}`,
				{ url: currentUrl, status: String(response.status) },
			);
		}

		return {
			url: currentUrl,
			status: response.status,
			contentType: response.headers.get("content-type") ?? undefined,
			body,
		};
	}

	throw authMdError(
		"AUTHMD_DISCOVERY_FAILED",
		`too many redirects starting at ${originalUrl}`,
		{ url: originalUrl },
	);
}

export async function requestJson(
	port: HttpPort,
	target: string,
	options: HttpRequestOptions = {},
): Promise<AuthMdJsonValue> {
	const response = await requestBounded(port, target, {
		accept: "application/json",
		...options,
	});
	try {
		return parseAuthMdJson(response.body);
	} catch {
		throw authMdError(
			"AUTHMD_METADATA_INVALID",
			`response from ${response.url} is not valid JSON`,
			{ url: response.url },
		);
	}
}

async function fetchOnce(
	port: HttpPort,
	url: HttpsUrl,
	timeoutMs: number,
	maxBytes: number,
	options: HttpRequestOptions,
): Promise<{ response: Response; body: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, timeoutMs);
	try {
		const headers = new Headers(options.headers);
		if (options.accept !== undefined) headers.set("accept", options.accept);
		if (options.jsonBody !== undefined && options.formBody !== undefined)
			throw authMdError(
				"AUTHMD_METADATA_INVALID",
				"request cannot combine JSON and form bodies",
			);
		if (options.jsonBody !== undefined)
			headers.set("content-type", "application/json");
		if (options.formBody !== undefined)
			headers.set("content-type", "application/x-www-form-urlencoded");
		const response = await port.fetchImpl(url, {
			method: options.method ?? "GET",
			headers,
			// Manual: cross-host redirects are rejected below, not followed.
			redirect: "manual",
			signal: controller.signal,
			body:
				options.formBody !== undefined
					? new URLSearchParams(options.formBody).toString()
					: options.jsonBody !== undefined
						? JSON.stringify(options.jsonBody)
						: null,
		});
		// Keep the request deadline active through the last response byte.
		if (response.status >= 200 && response.status < 300)
			return {
				response,
				body: await readBounded(response, maxBytes, url, controller.signal),
			};
		void response.body?.cancel().catch(() => {});
		return { response, body: "" };
	} catch (cause) {
		throw authMdError(
			"AUTHMD_DISCOVERY_FAILED",
			`request to ${url} failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
			{ url },
		);
	} finally {
		clearTimeout(timer);
	}
}

function nextRedirectTarget(
	response: Response,
	currentUrl: HttpsUrl,
	originalHost: string,
): HttpsUrl {
	const location = response.headers.get("location");
	if (location === null || location.length === 0) {
		throw authMdError(
			"AUTHMD_DISCOVERY_FAILED",
			`redirect from ${currentUrl} has no location header`,
			{ url: currentUrl },
		);
	}
	let resolved: URL;
	try {
		resolved = new URL(location, currentUrl);
	} catch {
		throw authMdError(
			"AUTHMD_DISCOVERY_FAILED",
			`redirect from ${currentUrl} has an unusable location`,
			{ url: currentUrl },
		);
	}
	if (resolved.host !== originalHost) {
		throw authMdError(
			"AUTHMD_DISCOVERY_FAILED",
			`refusing cross-host redirect from ${originalHost} to ${resolved.host}`,
			{ from: originalHost, to: resolved.host },
		);
	}
	return parseHttpsUrl(resolved.toString(), "redirectLocation");
}

async function readBounded(
	response: Response,
	maxBytes: number,
	url: HttpsUrl,
	signal: AbortSignal,
): Promise<string> {
	const declared = response.headers.get("content-length");
	if (declared !== null && Number.parseInt(declared, 10) > maxBytes) {
		void response.body?.cancel().catch(() => {});
		throw tooLarge(url, maxBytes);
	}

	const stream = response.body;
	if (stream) {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let received = 0;
		let text = "";
		try {
			for (;;) {
				const { done, value } = await readBeforeDeadline(reader, signal);
				if (done) break;
				received += value.byteLength;
				if (received > maxBytes) {
					throw tooLarge(url, maxBytes);
				}
				text += decoder.decode(value, { stream: true });
			}
			return text + decoder.decode();
		} finally {
			void reader.cancel().catch(() => {});
		}
	}

	const text = await response.text();
	if (new TextEncoder().encode(text).length > maxBytes) {
		throw tooLarge(url, maxBytes);
	}
	return text;
}

async function readBeforeDeadline(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	signal.throwIfAborted();
	let abort = () => {};
	const deadline = new Promise<never>((_resolve, reject) => {
		abort = () => reject(new Error("Response body deadline exceeded"));
		signal.addEventListener("abort", abort, { once: true });
	});
	try {
		return await Promise.race([reader.read(), deadline]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

function tooLarge(url: HttpsUrl, maxBytes: number) {
	return authMdError(
		"AUTHMD_DISCOVERY_FAILED",
		`response from ${url} exceeds the ${maxBytes}-byte bound`,
		{ url, maxBytes: String(maxBytes) },
	);
}
