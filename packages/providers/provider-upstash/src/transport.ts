/**
 * The HTTP boundary, as an injected port.
 *
 * Nothing in this package reaches for a global `fetch`. A host supplies a
 * transport; the guard below is what makes any supplied transport safe. That
 * matters more here than usual, because the control-plane call is
 * unauthenticated and anonymous: there is no account, no API key, and
 * therefore nothing that would fail if the request went somewhere else. An
 * attacker-controlled origin would simply hand back a markdown document with
 * their token in it, and the driver would faithfully bind a workload to a
 * Redis the attacker can read.
 *
 * So: HTTPS only, allowlisted host, no redirect chasing, bounded body,
 * bounded time — and two separate policies, because the control plane and the
 * data plane are different origins with different rules.
 */
import {
	assertAllowedEndpoint as assertAllowedEndpointCore,
	createBoundedFetchTransport,
	TransportGuardError,
	type TransportGuardPolicy,
} from "@hobo/core";
import { redactProviderText, UpstashProviderError } from "./errors.js";

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
 * already sent the request — and, on the data plane, the bearer token — to
 * the redirect target.
 */
export interface UpstashTransport {
	request(request: TransportRequest): Promise<TransportResponse>;
}

export type TransportPolicy = {
	/** Exact hostnames. */
	readonly allowedHosts: readonly string[];
	/** Suffixes, for the per-database data-plane origins. Must start with a dot. */
	readonly allowedHostSuffixes: readonly string[];
	readonly allowedPathPrefix: string;
	readonly maxResponseBytes: number;
	readonly timeoutMs: number;
};

/** The one documented no-signup origin. */
// public-contract: allowlisted control-plane host; widening it widens egress.
export const UPSTASH_CONTROL_PLANE_HOST = "upstash.com" as const;

/** Per-database REST origins are `<name>-<id>.upstash.io`. */
// public-contract: allowlisted data-plane suffix; widening it widens egress.
export const UPSTASH_DATA_PLANE_HOST_SUFFIX = ".upstash.io" as const;

export const UPSTASH_CONTROL_PLANE_POLICY: TransportPolicy = {
	allowedHosts: [UPSTASH_CONTROL_PLANE_HOST],
	allowedHostSuffixes: [],
	allowedPathPrefix: "/start-redis",
	// The create response is a markdown document with an inline quickstart, so
	// it is comfortably larger than a JSON envelope — and still nowhere near
	// this. A response over the cap is a contract change, not a big database.
	maxResponseBytes: 64 * 1024,
	timeoutMs: 15_000,
};

export const UPSTASH_DATA_PLANE_POLICY: TransportPolicy = {
	allowedHosts: [],
	allowedHostSuffixes: [UPSTASH_DATA_PLANE_HOST_SUFFIX],
	allowedPathPrefix: "/",
	// Comfortably above any single value: a `GET` of a maximum-size value
	// comes back JSON-encoded, and an `LRANGE` returns many at once, so a cap
	// set to the value limit would reject legitimate reads.
	maxResponseBytes: 8 * 1024 * 1024,
	timeoutMs: 10_000,
};

/**
 * This package's policy shape onto core's. Only the field names differ: the
 * prefix is singular here and the timeout cap is `timeoutMs`.
 */
function corePolicy(policy: TransportPolicy): TransportGuardPolicy {
	return {
		allowedHosts: policy.allowedHosts,
		allowedHostSuffixes: policy.allowedHostSuffixes,
		allowedPathPrefixes: [policy.allowedPathPrefix],
		maxResponseBytes: policy.maxResponseBytes,
		maxTimeoutMs: policy.timeoutMs,
	};
}

/**
 * Core refuses with a `TransportGuardError`; this package's callers catch
 * `UpstashProviderError`. Translating rather than re-throwing keeps the thrown
 * type — and the `PROVIDER_CONTRACT_CHANGED` code every call site already
 * matches on — exactly as it was before the URL check moved into core.
 */
function asProviderError(cause: Error): Error {
	if (!(cause instanceof TransportGuardError)) return cause;
	return new UpstashProviderError("PROVIDER_CONTRACT_CHANGED", cause.message, {
		detail: { guard: cause.code },
	});
}

/**
 * Parse an outbound URL against a policy. Returns the parsed URL so callers
 * cannot accidentally keep using the unchecked string.
 *
 * Every rule here now lives in `@hobo/core`, including the dot-anchored suffix
 * match the data plane needs. The copy this replaced applied the suffix without
 * checking its shape, so a policy written `"upstash.io"` rather than
 * `".upstash.io"` admitted `evilupstash.io` — measured, not theorised. Core
 * refuses that policy outright.
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

function headerValue(
	headers: Readonly<Record<string, string>>,
	name: string,
): string | undefined {
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lower) return value;
	}
	return undefined;
}

/**
 * Wrap any transport with the request/response invariants.
 *
 * A 3xx is rejected rather than followed: this API documents no redirects, so
 * one is either a contract change or a hijack, and neither should silently
 * resolve into a successful-looking parse.
 *
 * The URL check above is core's. This response half deliberately is not, and
 * the two differences are both ones where swapping in `guardTransport` would
 * change observable behaviour rather than share an implementation:
 *
 * - A caller that asks for more time or more bytes than the policy allows is
 *   *clamped* here and *refused* there. Core states the refusal as doctrine —
 *   a clamp turns an authoring mistake into a mystery timeout — and this
 *   package's suite pins the clamp. Reconciling them is a behaviour change to
 *   argue on its own merits, not a side effect of consolidating a guard.
 * - Any 3xx is refused here; core lets a `Location`-less 3xx (a 304) through
 *   as an ordinary cache answer. Adopting core's rule would relax a refusal
 *   this driver currently makes.
 */
export function createGuardedTransport(
	inner: UpstashTransport,
	policy: TransportPolicy,
): UpstashTransport {
	return {
		async request(request) {
			const url = assertAllowedEndpoint(request.url, policy);
			const timeoutMs = Math.min(request.timeoutMs, policy.timeoutMs);
			const maxResponseBytes = Math.min(
				request.maxResponseBytes,
				policy.maxResponseBytes,
			);
			if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
				throw new UpstashProviderError(
					"PROVIDER_CONTRACT_CHANGED",
					"request timeout must be positive",
				);
			}

			const response = await inner.request({
				...request,
				url: url.toString(),
				timeoutMs,
				maxResponseBytes,
			});

			if (response.status >= 300 && response.status < 400) {
				const location = headerValue(response.headers, "location") ?? "";
				throw new UpstashProviderError(
					"PROVIDER_CONTRACT_CHANGED",
					`provider returned a ${response.status} redirect, which this driver never follows`,
					{
						detail: {
							status: response.status,
							location: redactProviderText(location, 120),
						},
					},
				);
			}

			const declared = Number(
				headerValue(response.headers, "content-length") ?? Number.NaN,
			);
			if (Number.isFinite(declared) && declared > maxResponseBytes) {
				throw new UpstashProviderError(
					"PROVIDER_CONTRACT_CHANGED",
					`provider declared a ${declared} byte response, over the ${maxResponseBytes} byte cap`,
				);
			}
			if (Buffer.byteLength(response.body, "utf8") > maxResponseBytes) {
				throw new UpstashProviderError(
					"PROVIDER_CONTRACT_CHANGED",
					`provider response exceeded the ${maxResponseBytes} byte cap`,
				);
			}

			return response;
		},
	};
}

/**
 * Minimal WHATWG-fetch adapter. `fetchImpl` is required — the point of the
 * port is that reaching the network is always something a host decided to hand
 * over, never something a library reached for.
 */
export function createFetchTransport(options: {
	readonly fetchImpl: typeof globalThis.fetch;
}): UpstashTransport {
	const transport = createBoundedFetchTransport(options);
	return {
		async request(request) {
			try {
				return await transport(request);
			} catch (cause) {
				if (cause instanceof UpstashProviderError) throw cause;
				if (
					cause instanceof TransportGuardError &&
					cause.code === "TRANSPORT_BODY_TOO_LARGE"
				)
					throw new UpstashProviderError(
						"PROVIDER_CONTRACT_CHANGED",
						cause.message,
					);
				// A timed-out or dropped request never proves the server did
				// nothing, so it can only be reported as ambiguous.
				throw new UpstashProviderError(
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
