/**
 * The HTTP boundary for the Vercel REST API, as an injected port.
 *
 * Nothing in this package reaches for a global `fetch`. A host supplies a
 * transport; the guard below is what makes any supplied transport safe — HTTPS
 * only, allowlisted official hosts, allowlisted path prefixes, no redirect
 * chasing, bounded body, bounded time. A driver that trusts its transport can
 * be pointed at an attacker's origin by one bad config value, and on this path
 * the request headers carry the sponsoring credential.
 */
import {
	assertAllowedEndpoint as assertAllowedEndpointCore,
	createBoundedFetchTransport,
	guardTransport,
	TransportGuardError,
} from "@hobo/core";

import { VercelProviderError } from "./provider-errors.js";

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
export interface VercelTransport {
	request(request: TransportRequest): Promise<TransportResponse>;
}

export type TransportPolicy = {
	readonly allowedHosts: readonly string[];
	readonly allowedPathPrefixes: readonly string[];
	readonly maxResponseBytes: number;
	readonly timeoutMs: number;
};

/** The documented official REST origin. Nothing else is reachable. */
export const VERCEL_API_ALLOWED_HOSTS = ["api.vercel.com"] as const;

/** The dashboard host that serves the human claim ceremony. Never called. */
// public-contract: only host accepted for ownership-claim actions.
export const VERCEL_CLAIM_HOST = "vercel.com" as const;

/**
 * Path prefixes this driver uses, each pinned to a documented endpoint:
 * `POST /projects/{idOrName}/transfer-request`, `GET /v9/projects/{idOrName}`,
 * `DELETE /v3/user/tokens/{tokenId}`, and the marketplace installation surface.
 */
export const VERCEL_ALLOWED_PATH_PREFIXES = [
	"/projects/",
	"/v9/projects/",
	"/v3/user/tokens/",
	"/v1/installations/",
] as const;

export const DEFAULT_TRANSPORT_POLICY: TransportPolicy = {
	allowedHosts: VERCEL_API_ALLOWED_HOSTS,
	allowedPathPrefixes: VERCEL_ALLOWED_PATH_PREFIXES,
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

/**
 * Vercel's policy shape onto core's. Only the timeout field is named
 * differently; the rest is the same vocabulary.
 */
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
 * `VercelProviderError`. Translating rather than re-throwing keeps the thrown
 * type — and the `PROVIDER_CONTRACT_CHANGED` code every call site already
 * matches on — exactly as it was before the guard moved into core.
 */
function parseTransportMethod(method: string): TransportMethod {
	switch (method) {
		case "GET":
		case "POST":
		case "PUT":
		case "DELETE":
			return method;
		default:
			throw new VercelProviderError(
				"PROVIDER_CONTRACT_CHANGED",
				`unsupported method ${method}`,
			);
	}
}

function asProviderError(cause: Error): Error {
	if (!(cause instanceof TransportGuardError)) return cause;
	return new VercelProviderError("PROVIDER_CONTRACT_CHANGED", cause.message, {
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
	inner: VercelTransport,
	policy: TransportPolicy = DEFAULT_TRANSPORT_POLICY,
): VercelTransport {
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
}): VercelTransport {
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
				if (cause instanceof VercelProviderError) throw cause;
				// A timed-out or dropped request never proves the server did
				// nothing, so it can only be reported as ambiguous.
				throw new VercelProviderError(
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
