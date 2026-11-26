/**
 * The registry HTTP boundary, as an injected port.
 *
 * Nothing here reaches for a global `fetch`. A host supplies a transport, and the
 * guard below is what makes any supplied transport safe: HTTPS only, one
 * allowlisted origin, the `/v2/` distribution surface only, no redirect chasing,
 * bounded body, bounded time.
 *
 * Two of the rules are specific to an anonymous registry and worth stating plainly.
 *
 * **No credential leaves this package.** The guard refuses to send `authorization`,
 * `proxy-authorization`, `cookie`, or `x-registry-auth`, and it refuses a URL with
 * userinfo in it. ttl.sh authenticates nobody, so a credential on a request to it
 * could only be an accident, and the cost of that accident is a secret mailed to a
 * public service. The refusal happens before the request leaves the process.
 *
 * **A 401 is a contract change, not a prompt.** There is no token exchange here and
 * no code path that could acquire one. Being challenged means the thing answering
 * is not the service this package was written against, and continuing would be
 * guessing.
 *
 * Everything else — including a 404, which is the registry's normal end state, and
 * a 429 — is returned to the caller to interpret through `ttlShErrorForStatus`.
 */
import {
	assertAllowedEndpoint as assertAllowedEndpointCore,
	guardTransport,
	TransportGuardError,
} from "@hobo/core";

import { TtlShProviderError, ttlShErrorForStatus } from "./errors.js";
import { TTL_SH_REGISTRY_HOST } from "./reference.js";

export type TransportMethod =
	| "GET"
	| "HEAD"
	| "POST"
	| "PUT"
	| "PATCH"
	| "DELETE";

export type TransportRequest = {
	readonly method: TransportMethod;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: string;
	readonly timeoutMs: number;
	readonly maxResponseBytes: number;
};

export type TransportResponse = {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
};

/**
 * Implementations MUST NOT follow redirects and MUST abort at `timeoutMs`.
 * The guard re-checks both, but a transport that silently follows a 302 has
 * already sent the request to the redirect target.
 */
export interface TtlShTransport {
	request(request: TransportRequest): Promise<TransportResponse>;
}

export type TransportPolicy = {
	readonly allowedHosts: readonly string[];
	readonly allowedPathPrefix: string;
	readonly maxResponseBytes: number;
	readonly timeoutMs: number;
};

/**
 * One origin, exact match.
 *
 * Deliberately not a suffix match: `registry.ttl.sh` and `ttl.sh.evil.example.com`
 * both pass a naive `endsWith`, and one of them is somebody else's host.
 */
export const TTL_SH_REGISTRY_POLICY: TransportPolicy = {
	allowedHosts: [TTL_SH_REGISTRY_HOST],
	allowedPathPrefix: "/v2/",
	maxResponseBytes: 64 * 1024,
	timeoutMs: 15_000,
};

/** Headers that must never leave this package. */
export const FORBIDDEN_REQUEST_HEADERS = [
	"authorization",
	"proxy-authorization",
	"cookie",
	"x-registry-auth",
] as const;

export function assertAllowedEndpoint(
	url: string,
	policy: TransportPolicy,
): URL {
	try {
		return assertAllowedEndpointCore(url, corePolicy(policy));
	} catch (cause) {
		throw asProviderError(
			cause instanceof Error ? cause : new Error(String(cause)),
			url,
		);
	}
}

/**
 * True when the URL carries `user:pass@`, checked without trusting the string
 * to parse — `new URL` throws on the malformed ones core also rejects.
 */
function hasEmbeddedUserinfo(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.username !== "" || parsed.password !== "";
	} catch {
		return false;
	}
}

/**
 * ttl.sh authenticates nobody, so a credential header on an outbound request
 * can only be an accident — and one that leaks. Package policy, not a generic
 * HTTP invariant, so it stays here rather than moving into the shared guard.
 */
export function assertNoCredentialHeaders(
	headers: Readonly<Record<string, string>>,
): void {
	for (const key of Object.keys(headers)) {
		if (isForbiddenRequestHeader(key.toLowerCase())) {
			throw new TtlShProviderError(
				"CREDENTIAL_REFUSED",
				`refusing to send ${key.toLowerCase()} to ${TTL_SH_REGISTRY_HOST}; the service documents no authentication, so a credential here could only be an accident`,
				{ detail: { header: key.toLowerCase() } },
			);
		}
	}
}

/** ttl.sh's policy onto core's; the single prefix becomes a one-entry list. */
function corePolicy(policy: TransportPolicy) {
	return {
		allowedHosts: policy.allowedHosts,
		allowedPathPrefixes: [policy.allowedPathPrefix],
		maxResponseBytes: policy.maxResponseBytes,
		maxTimeoutMs: policy.timeoutMs,
	};
}

/**
 * Core refuses with a `TransportGuardError`; this package's callers catch
 * `TtlShProviderError`, and this package's codes are not core's.
 *
 * The userinfo case is kept separate on purpose. Core folds it into
 * `TRANSPORT_HOST_FORBIDDEN`, but ttl.sh reported it as `CREDENTIAL_REFUSED`
 * for a reason worth preserving: a `user:pass@` registry URL is a secret in
 * every log line that records the URL, and the registry authenticates nobody,
 * so a credential there could only leak. Collapsing it into the generic
 * transport refusal would lose that.
 */
function isForbiddenRequestHeader(name: string): boolean {
	switch (name) {
		case "authorization":
		case "proxy-authorization":
		case "cookie":
		case "x-registry-auth":
			return true;
		default:
			return false;
	}
}

function asProviderError(cause: Error, url?: string): Error {
	if (!(cause instanceof TransportGuardError)) return cause;
	if (url !== undefined && hasEmbeddedUserinfo(url)) {
		return new TtlShProviderError(
			"CREDENTIAL_REFUSED",
			`refusing a request url with embedded userinfo; ${TTL_SH_REGISTRY_HOST} authenticates nobody, so a credential here could only leak`,
		);
	}
	// This package draws a line core does not: refusing to *send* somewhere is
	// `TRANSPORT_NOT_ALLOWED`, while a peer answering in a shape the driver
	// never agreed to — a redirect, an oversized body, a request over the
	// policy bounds — is `PROVIDER_CONTRACT_CHANGED`. Callers switch on that
	// distinction, so the translation has to keep it rather than flatten
	// everything into one code.
	const endpointRefusal =
		cause.code === "TRANSPORT_SCHEME_FORBIDDEN" ||
		cause.code === "TRANSPORT_HOST_FORBIDDEN" ||
		cause.code === "TRANSPORT_PATH_FORBIDDEN";
	return new TtlShProviderError(
		endpointRefusal ? "TRANSPORT_NOT_ALLOWED" : "PROVIDER_CONTRACT_CHANGED",
		cause.message,
		{
			detail: {
				guard: cause.code,
				...(cause.detail.location !== undefined
					? { location: cause.detail.location }
					: undefined),
				...(cause.detail.host !== undefined
					? { host: cause.detail.host }
					: undefined),
				...(cause.detail.path !== undefined
					? { path: cause.detail.path }
					: undefined),
				...(cause.detail.url !== undefined
					? { url: cause.detail.url }
					: undefined),
				...(cause.detail.port !== undefined
					? { port: cause.detail.port }
					: undefined),
				...(cause.detail.allowed !== undefined
					? { allowed: cause.detail.allowed }
					: undefined),
			},
		},
	);
}

export function createGuardedTransport(
	inner: TtlShTransport,
	policy: TransportPolicy = TTL_SH_REGISTRY_POLICY,
): TtlShTransport {
	const guarded = guardTransport(
		async (request) =>
			await inner.request({
				method: request.method,
				url: request.url,
				headers: request.headers,
				...(request.body === undefined ? undefined : { body: request.body }),
				timeoutMs: request.timeoutMs,
				maxResponseBytes: request.maxResponseBytes,
			}),
		corePolicy(policy),
	);

	return {
		async request(request) {
			// Before anything leaves: ttl.sh takes no credential, so one on the
			// way out is an accident worth refusing rather than redacting.
			assertNoCredentialHeaders(request.headers);

			let response: TransportResponse;
			try {
				response = await guarded({
					method: request.method,
					url: request.url,
					headers: request.headers,
					...(request.body === undefined ? undefined : { body: request.body }),
					timeoutMs: request.timeoutMs,
					maxResponseBytes: request.maxResponseBytes,
				});
			} catch (cause) {
				throw asProviderError(
					cause instanceof Error ? cause : new Error(String(cause)),
					request.url,
				);
			}

			if (response.status === 401 || response.status === 403) {
				// ttl.sh-specific, and layered here rather than pushed into the
				// shared guard because it is a statement about this registry
				// rather than about HTTP: there is no credential to supply and
				// no retry that would help, so handing the challenge back would
				// only invite a caller to invent one.
				throw ttlShErrorForStatus(response.status, {
					method: request.method,
					body: response.body,
				});
			}

			return response;
		},
	};
}

/**
 * Minimal WHATWG-fetch adapter. `fetchImpl` is required — the point of the port is
 * that reaching the network is always something a host decided to hand over, never
 * something a library reached for.
 */
export function createFetchTransport(options: {
	readonly fetchImpl: typeof globalThis.fetch;
}): TtlShTransport {
	const { fetchImpl } = options;
	return {
		async request(request) {
			const controller = new AbortController();
			const timer = setTimeout(() => {
				controller.abort();
			}, request.timeoutMs);
			try {
				const response = await fetchImpl(request.url, {
					method: request.method,
					headers: { ...request.headers },
					...(request.body !== undefined ? { body: request.body } : undefined),
					redirect: "manual",
					signal: controller.signal,
				});
				const headers: Record<string, string> = {};
				response.headers.forEach((value, key) => {
					headers[key.toLowerCase()] = value;
				});
				const text = await response.text();
				if (Buffer.byteLength(text, "utf8") > request.maxResponseBytes) {
					throw new TtlShProviderError(
						"PROVIDER_CONTRACT_CHANGED",
						`ttl.sh response exceeded the ${request.maxResponseBytes} byte cap`,
					);
				}
				return { status: response.status, headers, body: text };
			} catch (cause) {
				if (cause instanceof TtlShProviderError) throw cause;
				// A dropped request never proves the registry did nothing.
				throw new TtlShProviderError(
					"PROVIDER_OPERATION_AMBIGUOUS",
					`${request.method} to ${TTL_SH_REGISTRY_HOST} did not complete`,
					{
						cause: cause instanceof Error ? cause : new Error(String(cause)),
						detail: { method: request.method },
					},
				);
			} finally {
				clearTimeout(timer);
			}
		},
	};
}
