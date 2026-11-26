/**
 * The Cloudflare-scoped guard policy for the injected HTTP transport.
 *
 * Why this module exists: the resolvers in `./resolvers.ts` talk to
 * Cloudflare's REST API directly — there is no IaC engine in the middle — and
 * every one of those requests carries a live account credential in its
 * headers. A driver that trusts whatever transport (and whatever URL) it is
 * handed can be pointed at an attacker's origin by one bad config value, and
 * the credential goes with it. So the transport is always injected, and the
 * policy below is what makes any injected transport safe on this path:
 * HTTPS-only, one exact host, one path prefix, no redirect chasing, bounded
 * body, bounded time. The enforcement itself lives in `guardTransport()` in
 * `@hobo/core`; this module only owns the Cloudflare-specific numbers, so the
 * rule set cannot drift per provider package.
 *
 * Nothing here reaches for a global `fetch`. Reaching the network is always
 * something a host decided to hand over, never something a library reached for.
 *
 * HONEST SCOPE: the guard constrains the request this package composes and the
 * response it accepts. It cannot prove the injected transport honours
 * `timeoutMs`, refuses to follow a 302 itself, or terminates TLS against the
 * real Cloudflare certificate — those are the host's obligations, restated in
 * the README. Passing the guard is not evidence that a live call was made.
 */

import {
	guardTransport,
	type HttpTransport,
	type TransportGuardPolicy,
} from "@hobo/core";

// public-contract: the only origin the Cloudflare resolvers ever address.
export const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com";

/** The documented official REST host. Nothing else is reachable. */
export const CLOUDFLARE_API_ALLOWED_HOSTS = Object.freeze([
	"api.cloudflare.com",
] as const);

/**
 * The single v4 prefix. Every endpoint the resolvers use is
 * `/client/v4/accounts/{account_id}/…`; a URL outside this prefix is either a
 * caller mistake or a redirect target, and both are refused rather than sent.
 */
export const CLOUDFLARE_API_ALLOWED_PATH_PREFIXES = Object.freeze([
	"/client/v4/",
] as const);

/** Base every resolver path is appended to. */
// public-contract: the base every resolver path is appended to, and half of the transport path allowlist.
export const CLOUDFLARE_API_BASE_PATH = "/client/v4";

/**
 * Caps. Cloudflare's control-plane calls are small and fast; a response larger
 * or slower than this is a contract change, not a big success.
 */
export const CLOUDFLARE_MAX_TIMEOUT_MS = 15_000;
export const CLOUDFLARE_MAX_RESPONSE_BYTES = 512 * 1024;

/**
 * The Cloudflare guard policy. A function rather than a constant so a caller
 * always receives the frozen policy this package stands behind and can never
 * mutate a shared object out from under another caller.
 */
export function cloudflareTransportPolicy(): TransportGuardPolicy {
	return Object.freeze({
		allowedHosts: CLOUDFLARE_API_ALLOWED_HOSTS,
		allowedPathPrefixes: CLOUDFLARE_API_ALLOWED_PATH_PREFIXES,
		maxTimeoutMs: CLOUDFLARE_MAX_TIMEOUT_MS,
		maxResponseBytes: CLOUDFLARE_MAX_RESPONSE_BYTES,
	});
}

/**
 * Wrap an injected transport with the Cloudflare policy. This is the only
 * transport the resolvers should ever be handed; passing an unguarded one is
 * legal TypeScript and a security defect.
 */
export function guardedCloudflareTransport(
	inner: HttpTransport,
): HttpTransport {
	return guardTransport(inner, cloudflareTransportPolicy());
}

/**
 * Build an absolute Cloudflare API URL from a `/client/v4`-relative path.
 *
 * Callers pass already-encoded segments; this only joins, so a caller that
 * forgets `encodeURIComponent` on a user-supplied name gets a URL the guard
 * will judge, not a silently repaired one.
 */
export function cloudflareApiUrl(path: string): string {
	const suffix = path.startsWith("/") ? path : `/${path}`;
	return `${CLOUDFLARE_API_ORIGIN}${CLOUDFLARE_API_BASE_PATH}${suffix}`;
}
