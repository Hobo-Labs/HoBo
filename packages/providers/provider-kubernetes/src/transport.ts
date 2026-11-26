/**
 * The HTTP boundary to a Kubernetes apiserver, as an injected port.
 *
 * Nothing in this package reaches for a global `fetch`, and nothing in it
 * reads a kubeconfig. A host supplies a transport that already carries
 * whatever credential the cluster wants; this package never sees it.
 *
 * Unlike a SaaS driver there is no host allowlist to write down — the
 * apiserver is the operator's own, at an address only they know. What can be
 * pinned is everything else: TLS (with one narrow, explicit loopback escape
 * for `kubectl proxy`), the two API path roots this driver uses, no redirect
 * chasing, a bounded body and a bounded wait.
 */
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

/**
 * Implementations MUST NOT follow redirects and MUST abort at `timeoutMs`.
 * The guard re-checks both, but a transport that silently follows a 302 has
 * already sent a namespaced object to the redirect target.
 */
export interface KubernetesTransport {
	request(request: TransportRequest): Promise<TransportResponse>;
}

export type TransportPolicy = {
	/** Only the API roots this driver actually uses. */
	readonly allowedPathPrefixes: readonly string[];
	/**
	 * `kubectl proxy` terminates TLS locally and serves plain HTTP on
	 * 127.0.0.1. That is the only cleartext apiserver address this driver will
	 * talk to, and only when a host opts in.
	 */
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

/**
 * Parse an outbound URL against the policy. Returns the parsed URL so callers
 * cannot accidentally use the unchecked string.
 */
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
	// `..` in a request path is how a namespaced call reaches a cluster-scoped
	// object. The apiserver would normalize it; this driver refuses it. The
	// literal check below only ever saw the literal form — the percent-encoded
	// one survives parsing and would reach the apiserver intact.
	// Also the raw path: `%2F` survives parsing, but `%2E%2E` does not — it is
	// decoded to `..` and then resolved away, so the normalized form no longer
	// carries the encoding this check is looking for.
	if (encodesPathSeparator(parsed.pathname) || encodesPathSeparator(rawPath)) {
		throw new KubernetesProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`apiserver path ${parsed.pathname} percent-encodes a path separator or dot segment, which this guard refuses rather than decodes`,
		);
	}
	// Checked against the *caller's* path, not `parsed.pathname`. `new URL()`
	// resolves dot segments while parsing, so by the time the URL exists a
	// namespaced `/api/v1/namespaces/default/../../nodes` has already become the
	// cluster-scoped `/api/v1/nodes` — which passes the root allowlist above and
	// reads, to every later frame, as a path the caller wrote. Inspecting the
	// normalized form is therefore blind to the exact escalation this refusal
	// exists to stop.
	if (rawPath.includes("//") || /(?:^|\/)\.\.?(?:\/|$)/u.test(rawPath)) {
		throw new KubernetesProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"apiserver path must be already-normalized",
		);
	}
	return parsed;
}

/**
 * The path the caller actually wrote, before `new URL()` resolves anything.
 *
 * Everything up to the authority is scheme and host; the path starts at the
 * first `/` after it, and ends at the query or fragment.
 */
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

/**
 * Wrap any transport with the request/response invariants.
 *
 * A 3xx is rejected outright rather than followed: the apiserver documents no
 * redirects on these paths, so one is either a contract change or a hijack,
 * and neither should silently resolve.
 */
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

/**
 * Minimal WHATWG-fetch adapter. `fetchImpl` is required — the point of the
 * port is that reaching a cluster is always something a host decided to hand
 * over, never something a library reached for.
 */
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
				// A timed-out write never proves the apiserver did nothing, so it
				// can only be reported as ambiguous.
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
