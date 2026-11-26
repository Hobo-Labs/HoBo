/**
 * The one boundary this provider crosses over the wire: the host page's own
 * asset origin, which serves the guest bundle.
 *
 * Everything after the fetch is a same-process instantiation. So the transport
 * is small, read-only, and aggressively same-origin: a component fetched from
 * somewhere else is code from somewhere else, and it would run with every
 * capability the host hands its guests.
 *
 * Bodies are bytes, not strings. One of the two routes returns WebAssembly,
 * and decoding it as UTF-8 to satisfy a string-shaped port would corrupt it.
 */
import { encodesPathSeparator } from "@hobo/core";
import { BrowserWasmProviderError, redactHostText } from "./errors.js";

export type TransportRequest = {
	readonly method: "GET";
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly timeoutMs: number;
	readonly maxResponseBytes: number;
};

export type TransportResponse = {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: Uint8Array;
};

export interface HostAssetTransport {
	request(request: TransportRequest): Promise<TransportResponse>;
}

// public-contract: reserved browser-host transport prefix.
export const HOST_ROUTE_PREFIX = "/_hobo/";

export type TransportPolicy = {
	/** The exact origin the host document was served from. */
	readonly origin: string;
	readonly maxResponseBytes: number;
	readonly timeoutMs: number;
	/** `http://localhost:*` for a dev server. Off by default. */
	readonly allowInsecureLocalhost: boolean;
};

export const DEFAULT_MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

export function defaultTransportPolicy(origin: string): TransportPolicy {
	return {
		origin,
		maxResponseBytes: DEFAULT_MAX_BUNDLE_BYTES,
		timeoutMs: 30_000,
		allowInsecureLocalhost: false,
	};
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Parse an outbound URL against the policy, returning the parsed URL. */
export function assertSameOriginAsset(
	url: string,
	policy: TransportPolicy,
): URL {
	let parsed: URL;
	let expected: URL;
	try {
		parsed = new URL(url);
		expected = new URL(policy.origin);
	} catch {
		throw new BrowserWasmProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"asset url is not a valid URL",
		);
	}
	if (parsed.protocol !== "https:") {
		const localDev =
			policy.allowInsecureLocalhost &&
			parsed.protocol === "http:" &&
			LOCAL_HOSTS.has(parsed.hostname);
		if (!localDev) {
			throw new BrowserWasmProviderError(
				"PROVIDER_CONTRACT_CHANGED",
				`guest bundles are fetched over https, not ${parsed.protocol.replace(":", "")}`,
			);
		}
	}
	if (parsed.origin !== expected.origin) {
		// A cross-origin component is code from somewhere else running with
		// every capability this host grants its guests.
		throw new BrowserWasmProviderError(
			"HOST_UNSUPPORTED",
			`guest bundle origin ${parsed.origin} is not the host origin`,
			{ detail: { origin: parsed.origin, hostOrigin: expected.origin } },
		);
	}
	if (!parsed.pathname.startsWith(HOST_ROUTE_PREFIX)) {
		throw new BrowserWasmProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`asset path ${parsed.pathname} is outside the ${HOST_ROUTE_PREFIX} route`,
		);
	}
	// The literal check below never saw the percent-encoded form, which
	// survives parsing and is decoded only when the asset is fetched — after
	// the same-origin and route checks have both passed.
	if (encodesPathSeparator(parsed.pathname)) {
		throw new BrowserWasmProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`asset path ${parsed.pathname} percent-encodes a path separator or dot segment, which this guard refuses rather than decodes`,
		);
	}
	if (parsed.pathname.includes("//") || parsed.pathname.includes("/..")) {
		throw new BrowserWasmProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"asset path must be already-normalized",
		);
	}
	return parsed;
}

/** Wrap any transport with the request/response invariants. */
export function createGuardedTransport(
	inner: HostAssetTransport,
	policy: TransportPolicy,
): HostAssetTransport {
	return {
		async request(request) {
			const url = assertSameOriginAsset(request.url, policy);
			const timeoutMs = Math.min(request.timeoutMs, policy.timeoutMs);
			const maxResponseBytes = Math.min(
				request.maxResponseBytes,
				policy.maxResponseBytes,
			);

			const response = await inner.request({
				...request,
				url: url.toString(),
				timeoutMs,
				maxResponseBytes,
			});

			if (response.status >= 300 && response.status < 400) {
				// A redirect on a bundle route is how a same-origin fetch becomes a
				// cross-origin one.
				throw new BrowserWasmProviderError(
					"HOST_UNSUPPORTED",
					`the host origin answered ${response.status}; bundle fetches never follow redirects`,
					{
						detail: {
							status: response.status,
							location: redactHostText(response.headers.location ?? "", 120),
						},
					},
				);
			}
			if (response.body.byteLength > maxResponseBytes) {
				throw new BrowserWasmProviderError(
					"BUNDLE_UNAVAILABLE",
					`the host origin returned ${response.body.byteLength} bytes, over the ${maxResponseBytes} byte cap`,
				);
			}
			return response;
		},
	};
}

export function decodeText(body: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: false }).decode(body);
}

export function headerOf(
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
 * Minimal WHATWG-fetch adapter. `fetchImpl` is required — reaching the network
 * is always something a host decided to hand over.
 */
export function createFetchTransport(options: {
	readonly fetchImpl: typeof globalThis.fetch;
}): HostAssetTransport {
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
					redirect: "manual",
					credentials: "omit",
					signal: controller.signal,
				});
				const headers: Record<string, string> = {};
				response.headers.forEach((value, key) => {
					headers[key.toLowerCase()] = value;
				});
				const body = new Uint8Array(await response.arrayBuffer());
				return { status: response.status, headers, body };
			} catch (cause) {
				if (cause instanceof BrowserWasmProviderError) throw cause;
				throw new BrowserWasmProviderError(
					"BUNDLE_UNAVAILABLE",
					"the guest bundle fetch did not complete",
					{
						cause: cause instanceof Error ? cause : new Error(String(cause)),
						retryable: true,
					},
				);
			} finally {
				clearTimeout(timer);
			}
		},
	};
}
