/**
 * The apiserver-scoped guard policy for the injected `HttpTransport` the
 * `ResourceResolver` contract runs over.
 *
 * ## Why this package has two transport modules
 *
 * `./transport.ts` is the driver's boundary: its own `KubernetesTransport`
 * shape, its own policy, and one narrow escape for `kubectl proxy` — cleartext
 * HTTP on loopback, which is how most people first touch a cluster. That
 * escape is real and load-bearing for the driver path, and it is also exactly
 * why the two cannot be one module: `guardTransport()` in `@hobo/core` is
 * HTTPS-only by construction, and the `ResourceResolver` contract runs over
 * core's `HttpTransport`, not this package's.
 *
 * So this module is the resolver-side policy, and the difference between the
 * two is a documented capability difference rather than duplication. The rules
 * the two lanes *share* are shared for real: `@hobo/core` exports
 * `encodesPathSeparator`, and the driver's own guard calls it, so neither lane
 * carries a private copy of the traversal rule. What differs is the one thing
 * that cannot be shared: **the resolvers do not support `kubectl proxy`.** A resolver handed a
 * `http://127.0.0.1:8001` apiserver is refused rather than quietly downgraded,
 * because the core guard would refuse it at the moment of the call and a
 * refusal at construction time names the fix.
 *
 * ## What the policy pins
 *
 * Unlike a SaaS provider there is no host to allowlist ahead of time — the
 * apiserver is the operator's own, at an address only they know. The policy is
 * therefore built *per apiserver URL*, exactly as the AWS provider builds one
 * per region: the host comes from the URL the operator supplied, and everything
 * else is pinned here. The path allowlist is the four API roots the resolvers
 * address and nothing else, so a resolver cannot be pointed at
 * `/apis/rbac.authorization.k8s.io/` on the same host by a config value.
 *
 * Nothing here reaches for a global `fetch`. Reaching the network is always
 * something a host decided to hand over, never something a library reached for.
 *
 * HONEST SCOPE: the guard constrains the request this package composes and the
 * response it accepts. It cannot prove the injected transport honours
 * `timeoutMs`, refuses to follow a 302 itself, or terminates TLS against the
 * cluster's real certificate — those are the host's obligations. Passing the
 * guard is not evidence that a live call was made.
 */

import {
	guardTransport,
	type HttpTransport,
	type TransportGuardPolicy,
} from "@hobo/core";
import { KubernetesProviderError } from "./errors.js";
import { isJsonString } from "./json.js";

/**
 * The API roots the resolvers address. Written out rather than derived, so
 * widening reach is an edit a reviewer can see rather than a pattern that
 * silently matches a new group.
 */
// public-contract: the closed set of apiserver path roots a resolver may address.
export const RESOLVER_ALLOWED_PATH_PREFIXES = Object.freeze([
	"/api/v1/",
	"/apis/apps/v1/",
	"/apis/batch/v1/",
	"/apis/networking.k8s.io/v1/",
] as const);

/**
 * Caps. These are control-plane calls: small documents, quick answers. A
 * response larger or slower than this is a contract change, not a big success.
 */
export const RESOLVER_MAX_TIMEOUT_MS = 30_000;
export const RESOLVER_MAX_RESPONSE_BYTES = 512 * 1024;

/**
 * Parse an apiserver root into the host the policy allowlists.
 *
 * A URL that does not parse, or one on plain HTTP, is refused here rather than
 * at the moment of the call: by then a ServiceAccount token is already in hand,
 * and a refusal at construction time can name the fix instead of surfacing as
 * a transport error three frames down.
 */
export interface ApiServerEndpoint {
	/** The hostname the guard allowlists, without the port. */
	readonly hostname: string;
	/** The port, as a string; empty when the URL used the default 443. */
	readonly port: string;
	/** `hostname` or `hostname:port`, as it appears in a URL authority. */
	readonly authority: string;
}

/**
 * Parse an apiserver root into the host and port the policy allowlists.
 *
 * A cluster's control plane listens on 6443, not 443, which is why
 * `TransportGuardPolicy` grew an `allowedPorts` field rather than this package
 * re-implementing the guard: a second copy of a security rule set drifts from
 * the first. The port is read off the operator's own URL and declared to the
 * policy, so widening is a fact about one cluster rather than a hole in the
 * guard.
 */
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

/** The hostname alone, for callers that only need the allowlist entry. */
export function parseApiServerHost<T>(apiServerUrl: T): string {
	return parseApiServerEndpoint(apiServerUrl).hostname;
}

/**
 * The guard policy for one apiserver. A function rather than a constant so a
 * caller always receives the frozen policy this package stands behind and can
 * never mutate a shared object out from under another caller.
 */
export function kubernetesResolverPolicy(
	apiServerUrl: string,
): TransportGuardPolicy {
	const endpoint = parseApiServerEndpoint(apiServerUrl);
	return Object.freeze({
		allowedHosts: Object.freeze([endpoint.hostname]),
		allowedPathPrefixes: RESOLVER_ALLOWED_PATH_PREFIXES,
		maxTimeoutMs: RESOLVER_MAX_TIMEOUT_MS,
		maxResponseBytes: RESOLVER_MAX_RESPONSE_BYTES,
		// Only the port this operator's own apiserver listens on — read off
		// their URL, never a range and never a guess.
		...(endpoint.port === ""
			? undefined
			: { allowedPorts: Object.freeze([endpoint.port]) }),
	});
}

/**
 * Wrap an injected transport with one apiserver's policy. This is the only
 * transport the resolvers should ever be handed; passing an unguarded one is
 * legal TypeScript and a security defect.
 */
export function guardedKubernetesTransport(
	inner: HttpTransport,
	apiServerUrl: string,
): HttpTransport {
	return guardTransport(inner, kubernetesResolverPolicy(apiServerUrl));
}

/**
 * Build an absolute apiserver URL.
 *
 * Callers pass an already-encoded path (and query); this only joins, so a
 * caller that forgets to encode a name gets a URL the guard will judge, not a
 * silently repaired one.
 */
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
