/**
 * The HTTP boundary for the Netlify REST API, as an injected port.
 *
 * Nothing in this package reaches for a global `fetch`. A host supplies a
 * transport; the guard below is what makes any supplied transport safe — HTTPS
 * only, allowlisted official hosts, allowlisted path prefixes, no redirect
 * chasing, bounded body, bounded time. This matters even on a path that starts
 * out anonymous, because the post-claim ownership check runs with the *claimer's*
 * token attached.
 */
import {
	assertAllowedEndpoint as assertAllowedEndpointCore,
	createBoundedFetchTransport,
	guardTransport,
	TransportGuardError,
} from "@hobo/core";

import { NetlifyProviderError } from "./provider-errors.js";

export type TransportMethod = "GET" | "POST" | "PUT" | "DELETE";

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
 * already sent the credentialed request to the redirect target.
 */
export interface NetlifyTransport {
	request(request: TransportRequest): Promise<TransportResponse>;
}

export type TransportPolicy = {
	readonly allowedHosts: readonly string[];
	readonly allowedPathPrefixes: readonly string[];
	readonly maxResponseBytes: number;
	readonly timeoutMs: number;
};

/** The documented official REST origin. Nothing else is reachable. */
export const NETLIFY_API_ALLOWED_HOSTS = ["api.netlify.com"] as const;

/** The dashboard host that serves the human claim ceremony. Never called. */
// public-contract: only host accepted for ownership-claim actions.
export const NETLIFY_CLAIM_HOST = "app.netlify.com" as const;

/**
 * Path prefixes this driver uses. Ownership after a claim is read from
 * `GET /api/v1/sites/{site_id}`, and nothing else on the anonymous path talks
 * to the API at all.
 */
export const NETLIFY_ALLOWED_PATH_PREFIXES = ["/api/v1/sites/"] as const;

export const DEFAULT_TRANSPORT_POLICY: TransportPolicy = {
	allowedHosts: NETLIFY_API_ALLOWED_HOSTS,
	allowedPathPrefixes: NETLIFY_ALLOWED_PATH_PREFIXES,
	maxResponseBytes: 256 * 1024,
	timeoutMs: 15_000,
};

/**
 * Parse an outbound URL against the policy. Returns the parsed URL so callers
 * cannot accidentally use the unchecked string.
 */
export function assertAllowedEndpoint(
	url: string,
	policy: TransportPolicy,
): URL {
	try {
		return assertAllowedEndpointCore(url, corePolicy(policy));
	} catch (cause) {
		throw asProviderError(
			cause instanceof Error ? cause : new Error(String(cause)),
		);
	}
}

/** Netlify's policy shape onto core's; only the timeout field is renamed. */
function corePolicy(policy: TransportPolicy) {
	return {
		allowedHosts: policy.allowedHosts,
		allowedPathPrefixes: policy.allowedPathPrefixes,
		maxResponseBytes: policy.maxResponseBytes,
		maxTimeoutMs: policy.timeoutMs,
	};
}

/**
 * Core refuses with a `TransportGuardError`; this package's callers catch
 * `NetlifyProviderError`. Translating keeps the thrown type and the
 * `PROVIDER_CONTRACT_CHANGED` code every call site matches on.
 */
function parseTransportMethod(method: string): TransportMethod {
	switch (method) {
		case "GET":
		case "POST":
		case "PUT":
		case "DELETE":
			return method;
		default:
			throw new NetlifyProviderError(
				"PROVIDER_CONTRACT_CHANGED",
				`unsupported method ${method}`,
			);
	}
}

function asProviderError(cause: Error): Error {
	if (!(cause instanceof TransportGuardError)) return cause;
	return new NetlifyProviderError("PROVIDER_CONTRACT_CHANGED", cause.message, {
		detail: { guard: cause.code },
	});
}

/**
 * Wrap any transport with the request/response invariants.
 *
 * A 3xx is rejected outright rather than followed: the REST API documents no
 * redirects on these endpoints, so one is either a contract change or a hijack,
 * and neither should silently resolve with the credential attached.
 */
export function createGuardedTransport(
	inner: NetlifyTransport,
	policy: TransportPolicy = DEFAULT_TRANSPORT_POLICY,
): NetlifyTransport {
	const guarded = guardTransport(
		async (request) =>
			await inner.request({
				method: parseTransportMethod(request.method),
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
			try {
				return await guarded({
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
				);
			}
		},
	};
}

/**
 * Minimal WHATWG-fetch adapter. `fetchImpl` is required — the point of the port
 * is that reaching the network is always something a host decided to hand over,
 * never something a library reached for.
 */
export function createFetchTransport(options: {
	readonly fetchImpl: typeof globalThis.fetch;
}): NetlifyTransport {
	const dispatch = createBoundedFetchTransport(options);
	return {
		async request(request) {
			try {
				return await dispatch(request);
			} catch (cause) {
				if (
					cause instanceof TransportGuardError &&
					cause.code !== "TRANSPORT_TIMEOUT_EXCEEDED"
				)
					throw asProviderError(cause);
				if (cause instanceof NetlifyProviderError) throw cause;
				// A timed-out or dropped request never proves the server did
				// nothing, so it can only be reported as ambiguous.
				throw new NetlifyProviderError(
					"PROVIDER_OPERATION_AMBIGUOUS",
					`${request.method} to the provider did not complete`,
					{
						cause: cause instanceof Error ? cause : new Error(String(cause)),
						detail: { method: request.method },
					},
				);
			}
		},
	};
}
