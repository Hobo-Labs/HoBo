/**
 * The HTTP boundary for the claimable-database API, as an injected port.
 *
 * Nothing in this package reaches for a global `fetch`. A host supplies a
 * transport; the guard below is what makes any supplied transport safe —
 * HTTPS only, one allowlisted host, no redirect chasing, bounded body, bounded
 * time. A driver that trusts its transport is a driver that can be pointed at
 * an attacker's origin by a single bad config value.
 */
import {
	assertAllowedEndpoint as assertAllowedEndpointCore,
	createBoundedFetchTransport,
	guardTransport,
	TransportGuardError,
} from "@hobo/core";

import { NeonProviderError } from "./errors.js";

export type TransportMethod = "GET" | "POST";

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
 * already sent the request body to the redirect target.
 */
export interface NeonTransport {
	request(request: TransportRequest): Promise<TransportResponse>;
}

export type TransportPolicy = {
	readonly allowedHosts: readonly string[];
	readonly allowedPathPrefix: string;
	readonly maxResponseBytes: number;
	readonly timeoutMs: number;
};

/** Only the documented official origin. Neon Launchpad has exactly one. */
export const NEON_ALLOWED_HOSTS = ["neon.new"] as const;

export const DEFAULT_TRANSPORT_POLICY: TransportPolicy = {
	allowedHosts: NEON_ALLOWED_HOSTS,
	allowedPathPrefix: "/api/v1/",
	maxResponseBytes: 64 * 1024,
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
 * Neon's policy onto core's. The single `allowedPathPrefix` becomes a one-entry
 * list; core takes an array because most callers pin several endpoints.
 */
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
 * `NeonProviderError`. Translating keeps the thrown type and the code every
 * call site matches on.
 */
function parseTransportMethod(method: string): TransportMethod {
	switch (method) {
		case "GET":
		case "POST":
			return method;
		default:
			throw new NeonProviderError(
				"PROVIDER_CONTRACT_CHANGED",
				`unsupported method ${method}`,
			);
	}
}

function asProviderError(cause: Error): Error {
	if (!(cause instanceof TransportGuardError)) return cause;
	return new NeonProviderError("PROVIDER_CONTRACT_CHANGED", cause.message, {
		detail: { guard: cause.code },
	});
}

/**
 * Wrap any transport with the request/response invariants.
 *
 * A 3xx is rejected outright rather than followed: the claimable-database API
 * documents no redirects, so one is either a contract change or a hijack, and
 * neither should silently resolve.
 */
export function createGuardedTransport(
	inner: NeonTransport,
	policy: TransportPolicy = DEFAULT_TRANSPORT_POLICY,
): NeonTransport {
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
 * Minimal WHATWG-fetch adapter. `fetchImpl` is required — the point of the
 * port is that reaching the network is always something a host decided to
 * hand over, never something a library reached for.
 */
export function createFetchTransport(options: {
	readonly fetchImpl: typeof globalThis.fetch;
}): NeonTransport {
	const transport = createBoundedFetchTransport(options);
	return {
		async request(request) {
			try {
				return await transport(request);
			} catch (cause) {
				if (cause instanceof NeonProviderError) throw cause;
				if (
					cause instanceof TransportGuardError &&
					cause.code === "TRANSPORT_BODY_TOO_LARGE"
				)
					throw new NeonProviderError(
						"PROVIDER_CONTRACT_CHANGED",
						cause.message,
					);
				// A timed-out or dropped request never proves the server did
				// nothing, so it can only be reported as ambiguous.
				throw new NeonProviderError(
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
