import { encodesPathSeparator } from "@hobo/core";
import { KubernetesProviderError, redactClusterText } from "./errors.js";

export type TransportMethod = "GET" | "POST" | "DELETE";

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

export interface KubernetesTransport {
	request(request: TransportRequest): Promise<TransportResponse>;
}

export type TransportPolicy = {
	readonly allowedPathPrefixes: readonly string[];
	readonly allowInsecureLoopback: boolean;
	readonly maxResponseBytes: number;
	readonly timeoutMs: number;
};

export const DEFAULT_TRANSPORT_POLICY: TransportPolicy = {
	allowedPathPrefixes: ["/api/v1/", "/apis/apps/v1/"],
	allowInsecureLoopback: false,
	maxResponseBytes: 512 * 1024,
	timeoutMs: 30_000,
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function assertAllowedEndpoint(
	url: string,
	policy: TransportPolicy,
): URL {
	const rawPath = rawPathOf(url);
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new KubernetesProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"apiserver url is not a valid URL",
		);
	}
	const loopback = LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
	if (parsed.protocol !== "https:") {
		if (
			!(policy.allowInsecureLoopback && parsed.protocol === "http:" && loopback)
		) {
			throw new KubernetesProviderError(
				"PROVIDER_CONTRACT_CHANGED",
				`apiserver url must use https, got ${parsed.protocol.replace(":", "")}`,
			);
		}
	}
	if (parsed.username !== "" || parsed.password !== "") {
		throw new KubernetesProviderError(
			"PROVIDER_AUTH_FAILED",
			"apiserver url must not embed userinfo; credentials belong to the transport",
		);
	}
	if (
		!policy.allowedPathPrefixes.some((prefix) =>
			parsed.pathname.startsWith(prefix),
		)
	) {
		throw new KubernetesProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`path ${parsed.pathname} is outside the ${policy.allowedPathPrefixes.join(" / ")} roots this driver uses`,
		);
	}
	if (encodesPathSeparator(parsed.pathname) || encodesPathSeparator(rawPath)) {
		throw new KubernetesProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`apiserver path ${parsed.pathname} percent-encodes a path separator or dot segment, which this guard refuses rather than decodes`,
		);
	}
	if (rawPath.includes("//") || /(?:^|\/)\.\.?(?:\/|$)/u.test(rawPath)) {
		throw new KubernetesProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"apiserver path must be already-normalized",
		);
	}
	return parsed;
}

function rawPathOf(url: string): string {
	const afterScheme = url.indexOf("://");
	const start = url.indexOf("/", afterScheme < 0 ? 0 : afterScheme + 3);
	if (start < 0) return "";
	const end = Math.min(
		...[url.indexOf("?", start), url.indexOf("#", start), url.length].filter(
			(index) => index >= 0,
		),
	);
	return url.slice(start, end);
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

export function createGuardedTransport(
	inner: KubernetesTransport,
	policy: TransportPolicy = DEFAULT_TRANSPORT_POLICY,
): KubernetesTransport {
	return {
		async request(request) {
			const url = assertAllowedEndpoint(request.url, policy);
			const timeoutMs = Math.min(request.timeoutMs, policy.timeoutMs);
			const maxResponseBytes = Math.min(
				request.maxResponseBytes,
				policy.maxResponseBytes,
			);
			if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
				throw new KubernetesProviderError(
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
				throw new KubernetesProviderError(
					"PROVIDER_CONTRACT_CHANGED",
					`apiserver returned a ${response.status} redirect, which this driver never follows`,
					{
						detail: {
							status: response.status,
							location: redactClusterText(
								headerValue(response.headers, "location") ?? "",
								120,
							),
						},
					},
				);
			}

			if (byteLength(response.body) > maxResponseBytes) {
				throw new KubernetesProviderError(
					"PROVIDER_CONTRACT_CHANGED",
					`apiserver response exceeded the ${maxResponseBytes} byte cap`,
				);
			}

			return response;
		},
	};
}

function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

export function createFetchTransport(options: {
	readonly fetchImpl: typeof globalThis.fetch;
}): KubernetesTransport {
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
				if (byteLength(text) > request.maxResponseBytes) {
					throw new KubernetesProviderError(
						"PROVIDER_CONTRACT_CHANGED",
						`apiserver response exceeded the ${request.maxResponseBytes} byte cap`,
					);
				}
				return { status: response.status, headers, body: text };
			} catch (cause) {
				if (cause instanceof KubernetesProviderError) throw cause;
				throw new KubernetesProviderError(
					"PROVIDER_OPERATION_AMBIGUOUS",
					`${request.method} to the apiserver did not complete`,
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
