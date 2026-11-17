import {
	guardTransport,
	type HttpTransport,
	type TransportGuardPolicy,
} from "@hobo/core";
import { KubernetesProviderError } from "./errors.js";
import { isJsonString } from "./json.js";

// public-contract: the closed set of apiserver path roots a resolver may address.
export const RESOLVER_ALLOWED_PATH_PREFIXES = Object.freeze([
	"/api/v1/",
	"/apis/apps/v1/",
	"/apis/batch/v1/",
	"/apis/networking.k8s.io/v1/",
] as const);

export const RESOLVER_MAX_TIMEOUT_MS = 30_000;
export const RESOLVER_MAX_RESPONSE_BYTES = 512 * 1024;

export interface ApiServerEndpoint {
	readonly hostname: string;
	readonly port: string;
	readonly authority: string;
}

export function parseApiServerEndpoint<T>(apiServerUrl: T): ApiServerEndpoint {
	if (!isJsonString(apiServerUrl) || apiServerUrl.trim().length === 0) {
		throw new KubernetesProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"kubernetes resolvers need an apiServerUrl: the cluster address is the operator's own and is never guessed",
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(apiServerUrl);
	} catch {
		throw new KubernetesProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`kubernetes resolvers: apiServerUrl ${JSON.stringify(apiServerUrl)} is not a valid URL, and an unparseable address would be interpolated into a request nobody reviewed`,
		);
	}
	if (parsed.protocol !== "https:") {
		throw new KubernetesProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`kubernetes resolvers: apiServerUrl ${JSON.stringify(apiServerUrl)} is not https. The ResourceResolver path runs over @hobo/core's transport guard, which is HTTPS-only — the "kubectl proxy" cleartext-loopback escape exists on the driver path (see ./transport.ts) and deliberately not here, because a projected ServiceAccount token is in the header of every one of these calls`,
		);
	}
	return Object.freeze({
		hostname: parsed.hostname,
		port: parsed.port,
		authority: parsed.host,
	});
}

export function parseApiServerHost<T>(apiServerUrl: T): string {
	return parseApiServerEndpoint(apiServerUrl).hostname;
}

export function kubernetesResolverPolicy(
	apiServerUrl: string,
): TransportGuardPolicy {
	const endpoint = parseApiServerEndpoint(apiServerUrl);
	return Object.freeze({
		allowedHosts: Object.freeze([endpoint.hostname]),
		allowedPathPrefixes: RESOLVER_ALLOWED_PATH_PREFIXES,
		maxTimeoutMs: RESOLVER_MAX_TIMEOUT_MS,
		maxResponseBytes: RESOLVER_MAX_RESPONSE_BYTES,
		...(endpoint.port === ""
			? undefined
			: { allowedPorts: Object.freeze([endpoint.port]) }),
	});
}

export function guardedKubernetesTransport(
	inner: HttpTransport,
	apiServerUrl: string,
): HttpTransport {
	return guardTransport(inner, kubernetesResolverPolicy(apiServerUrl));
}

export function kubernetesResolverUrl(
	apiServerUrl: string,
	path: string,
): string {
	const { authority } = parseApiServerEndpoint(apiServerUrl);
	const suffix = path.startsWith("/") ? path : `/${path}`;
	if (
		!RESOLVER_ALLOWED_PATH_PREFIXES.some((prefix) => suffix.startsWith(prefix))
	) {
		throw new KubernetesProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`kubernetes resolvers: path ${JSON.stringify(path)} is outside the allowlisted API roots (${RESOLVER_ALLOWED_PATH_PREFIXES.join(", ")})`,
		);
	}
	return `https://${authority}${suffix}`;
}
