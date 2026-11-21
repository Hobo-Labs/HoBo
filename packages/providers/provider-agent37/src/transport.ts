import {
	createBoundedFetchTransport,
	guardTransport,
	type HttpTransport,
	type TransportResponse,
} from "@hobo/core";
import { z } from "zod";

// public-contract: the only Sandbox API origin allowed to receive the key.
export const AGENT37_API_ORIGIN = "https://api.agent37.com";
// public-contract: the only exec origin allowed to receive the key.
export const AGENT37_EXEC_ORIGIN = "https://sandbox.agent37.app";
export const AGENT37_ALLOWED_HOSTS = Object.freeze([
	"api.agent37.com",
	"sandbox.agent37.app",
]);
export const AGENT37_MAX_TIMEOUT_MS = 905_000;
export const AGENT37_MAX_RESPONSE_BYTES = 1_048_576;

export type Agent37TransportOptions = {
	readonly fetchImpl: typeof globalThis.fetch;
	readonly maxAttempts?: number;
	readonly retryBaseDelayMs?: number;
	readonly sleep?: (milliseconds: number) => Promise<void>;
	readonly random?: () => number;
	readonly now?: () => number;
};

const errorEnvelope = z.union([
	z.object({ error: z.string() }).transform((value) => value.error),
	z
		.object({ error: z.object({ code: z.string() }) })
		.transform((value) => value.error.code),
]);

function errorCode(body: string): string | undefined {
	try {
		const parsed = errorEnvelope.safeParse(JSON.parse(body));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

function header(response: TransportResponse, name: string): string | undefined {
	for (const [key, value] of Object.entries(response.headers))
		if (key.toLowerCase() === name) return value;
	return undefined;
}

export function agent37RetryAfterMs(
	response: TransportResponse,
	now: number,
): number | undefined {
	const value = header(response, "retry-after");
	if (value === undefined) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0)
		return Math.min(seconds * 1000, AGENT37_MAX_TIMEOUT_MS);
	const date = Date.parse(value);
	if (!Number.isFinite(date)) return undefined;
	return Math.min(Math.max(0, date - now), AGENT37_MAX_TIMEOUT_MS);
}

function retryable(response: TransportResponse): boolean {
	if (response.status >= 500 && response.status <= 599) return true;
	const code = errorCode(response.body);
	return code === "no_capacity" || code === "try_again";
}

export function createAgent37Transport(
	options: Agent37TransportOptions,
): HttpTransport {
	const bounded = guardTransport(
		createBoundedFetchTransport({ fetchImpl: options.fetchImpl }),
		{
			allowedHosts: AGENT37_ALLOWED_HOSTS,
			allowedPathPrefixes: ["/v1/"],
			maxTimeoutMs: AGENT37_MAX_TIMEOUT_MS,
			maxResponseBytes: AGENT37_MAX_RESPONSE_BYTES,
		},
	);
	const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 3, 6));
	const retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 250);
	const sleep =
		options.sleep ??
		((milliseconds: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
	const random = options.random ?? Math.random;
	const now = options.now ?? Date.now;

	return async (request) => {
		let response: TransportResponse | undefined;
		let retryWindowMs = AGENT37_MAX_TIMEOUT_MS;
		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			response = await bounded(request);
			if (
				(request.method !== "GET" && request.method !== "HEAD") ||
				!retryable(response) ||
				attempt + 1 === maxAttempts ||
				retryWindowMs === 0
			)
				return response;
			const backoff = retryBaseDelayMs * 2 ** attempt;
			const jitter = backoff * random();
			const retryAfter = agent37RetryAfterMs(response, now());
			const delay = Math.min(
				Math.max(backoff + jitter, retryAfter ?? 0),
				retryWindowMs,
			);
			retryWindowMs -= delay;
			await sleep(delay);
		}
		if (response === undefined)
			throw new Error("Agent37 request was not attempted");
		return response;
	};
}
