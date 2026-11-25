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

export interface NeonTransport {
	request(request: TransportRequest): Promise<TransportResponse>;
}

export type TransportPolicy = {
	readonly allowedHosts: readonly string[];
	readonly allowedPathPrefix: string;
	readonly maxResponseBytes: number;
	readonly timeoutMs: number;
};

export const NEON_ALLOWED_HOSTS = ["neon.new"] as const;

export const DEFAULT_TRANSPORT_POLICY: TransportPolicy = {
	allowedHosts: NEON_ALLOWED_HOSTS,
	allowedPathPrefix: "/api/v1/",
	maxResponseBytes: 64 * 1024,
	timeoutMs: 15_000,
};

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

function corePolicy(policy: TransportPolicy) {
	return {
		allowedHosts: policy.allowedHosts,
		allowedPathPrefixes: [policy.allowedPathPrefix],
		maxResponseBytes: policy.maxResponseBytes,
		maxTimeoutMs: policy.timeoutMs,
	};
}

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
