import {
	createBoundedFetchTransport,
	guardTransport,
	type HttpTransport,
	type TransportResponse,
} from "@hobo/core";
import { z } from "zod";

// public-contract: clients and contract fixtures pin the documented API origin.
export const AGENT37_API_ORIGIN = "https://api.agent37.com";
// public-contract: clients and contract fixtures pin the documented exec origin.
export const AGENT37_EXEC_ORIGIN = "https://sandbox.agent37.app";
export const AGENT37_ALLOWED_HOSTS = Object.freeze([
	"api.agent37.com",
	"sandbox.agent37.app",
]);
export const AGENT37_ALLOWED_PATH_PREFIXES = Object.freeze(["/v1/"]);
export const AGENT37_MAX_TIMEOUT_MS = 905_000;
export const AGENT37_MAX_RESPONSE_BYTES = 1_048_576;
export const AGENT37_MAX_REQUEST_BYTES = 1_048_576;

export type Agent37TransportOptions = {
	readonly fetchImpl: typeof globalThis.fetch;
	readonly maxAttempts?: number;
	readonly retryBaseDelayMs?: number;
	readonly sleep?: (milliseconds: number) => Promise<void>;
	readonly random?: () => number;
	readonly now?: () => number;
};

const errorBody = z.union([
	z.object({ error: z.string() }).transform(({ error }) => error),
	z
		.object({ error: z.object({ code: z.string() }) })
		.transform(({ error }) => error.code),
]);

function responseHeader(
	response: TransportResponse,
	name: string,
): string | undefined {
	const entry = Object.entries(response.headers).find(
		([key]) => key.toLowerCase() === name,
	);
	return entry?.[1];
}

function providerErrorCode(body: string): string | undefined {
	try {
		const parsed = errorBody.safeParse(JSON.parse(body));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

function permitsAutomaticRetry(method: string): boolean {
	return method === "GET" || method === "HEAD";
}

function permitsResponseRetry(response: TransportResponse): boolean {
	if (response.status >= 500 && response.status <= 599) return true;
	const code = providerErrorCode(response.body);
	return code === "no_capacity" || code === "try_again";
}

export function agent37RetryAfterMs(
	response: TransportResponse,
	now: number,
): number | undefined {
	const value = responseHeader(response, "retry-after");
	if (value === undefined) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.min(seconds * 1000, AGENT37_MAX_TIMEOUT_MS);
	}
	const dateMs = Date.parse(value);
	if (!Number.isFinite(dateMs)) return undefined;
	return Math.min(Math.max(0, dateMs - now), AGENT37_MAX_TIMEOUT_MS);
}

export function createAgent37Transport(
	options: Agent37TransportOptions,
): HttpTransport {
	const bounded = guardTransport(
		createBoundedFetchTransport({ fetchImpl: options.fetchImpl }),
		{
			allowedHosts: AGENT37_ALLOWED_HOSTS,
			allowedPathPrefixes: AGENT37_ALLOWED_PATH_PREFIXES,
			maxTimeoutMs: AGENT37_MAX_TIMEOUT_MS,
			maxResponseBytes: AGENT37_MAX_RESPONSE_BYTES,
		},
	);
	const attempts = Math.max(1, Math.min(options.maxAttempts ?? 3, 6));
	const baseDelay = Math.max(0, options.retryBaseDelayMs ?? 250);
	const sleep =
		options.sleep ??
		((milliseconds: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
	const random = options.random ?? Math.random;
	const now = options.now ?? Date.now;

	return async (request) => {
		if (
			request.body !== undefined &&
			Buffer.byteLength(request.body, "utf8") > AGENT37_MAX_REQUEST_BYTES
		) {
			throw new Error(
				`Agent37 request body exceeds ${AGENT37_MAX_REQUEST_BYTES} bytes`,
			);
		}
		let remainingDelayMs = AGENT37_MAX_TIMEOUT_MS;
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			const response = await bounded(request);
			const finalAttempt = attempt + 1 === attempts;
			if (
				!permitsAutomaticRetry(request.method) ||
				!permitsResponseRetry(response) ||
				finalAttempt ||
				remainingDelayMs === 0
			) {
				return response;
			}
			const exponentialMs = baseDelay * 2 ** attempt;
			const jitterMs = exponentialMs * random();
			const retryAfterMs = agent37RetryAfterMs(response, now()) ?? 0;
			const delayMs = Math.min(
				Math.max(exponentialMs + jitterMs, retryAfterMs),
				remainingDelayMs,
			);
			remainingDelayMs -= delayMs;
			await sleep(delayMs);
		}
		throw new Error("Agent37 request was not attempted");
	};
}
