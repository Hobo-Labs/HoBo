/**
 * The Hostinger-scoped guard policy for the injected HTTP transport.
 *
 * Why this module exists: the resolvers in `./resolvers.ts` call the Hostinger
 * API directly — there is no IaC engine in the middle — and every one of those
 * requests carries a live account API token in its `authorization` header. A
 * driver that trusts whatever transport (and whatever URL) it is handed can be
 * pointed at an attacker's origin by one bad config value, and the token goes
 * with it. So the transport is always injected, and the policy below is what
 * makes an injected transport safe on this path: HTTPS only, one exact host,
 * an explicit set of path prefixes, no redirect chasing, bounded body, bounded
 * time. Enforcement itself lives in `guardTransport()` in `@hobo/core`; this
 * module owns only the Hostinger-specific numbers and hosts, so the rule set
 * cannot drift per provider package.
 *
 * Hostinger namespaces its API by product under one host (`/api/vps/v1`,
 * `/api/dns/v1`, `/api/domains/v1`, `/api/billing/v1`), and this policy
 * allowlists **two** of those prefixes. The omission that matters is
 * `/api/billing/v1`: that is the surface that places orders, and a resolver
 * that could reach it could spend the account's money. Keeping it out of the
 * allowlist is what makes "this package will not buy anything" a property of
 * the transport rather than a promise in a comment.
 *
 * Nothing here reaches for a global `fetch`. Reaching the network is always
 * something a host decided to hand over, never something a library reached for.
 *
 * HONEST SCOPE: the guard constrains the request this package composes and the
 * response it accepts. It cannot prove the injected transport honours
 * `timeoutMs`, refuses to follow a 302 itself, or terminates TLS against the
 * real Hostinger certificate — those are the host's obligations. Passing the
 * guard is not evidence that a live call was made.
 */

import {
	guardTransport,
	type HttpTransport,
	type TransportGuardPolicy,
} from "@hobo/core";

// public-contract: the single host every Hostinger API call reaches.
export const HOSTINGER_API_HOST = "developers.hostinger.com";

/**
 * The product namespaces the resolvers may address. `/api/billing/v1` is
 * deliberately absent — see the module note.
 *
 * `/api/hosting/v1/` carries websites and their databases. It is *not* the
 * order-placing surface: `POST /api/hosting/v1/websites` takes an `order_id`
 * for a plan the account already bought and refuses without one, so a resolver
 * reaching it can fill a plan but cannot buy one. That distinction is the whole
 * reason this list names namespaces rather than a host.
 */
// public-contract: the path allowlist for the Hostinger transport guard; adding /api/billing/v1 here would let this package place an order.
export const HOSTINGER_ALLOWED_PATH_PREFIXES = Object.freeze([
	"/api/vps/v1/",
	"/api/dns/v1/",
	"/api/hosting/v1/",
] as const);

/**
 * The namespace this package refuses to reach, and why. Exported so the reason
 * travels with the code: a contributor adding a "just provision it" resolver
 * should have to read this before widening the policy.
 */
// public-contract: the Hostinger namespace deliberately excluded from the guard; widening to it would let a resolver spend money.
export const HOSTINGER_EXCLUDED_PATH_PREFIXES = Object.freeze({
	billing: Object.freeze({
		prefix: "/api/billing/v1/",
		reason:
			"this is the order-placing surface; a resolver that could reach it could spend the account's money without a human deciding to",
	}),
});

/**
 * Caps. These are control-plane calls: small bodies, quick answers. A response
 * larger or slower than this is a contract change, not a big success.
 */
export const HOSTINGER_MAX_TIMEOUT_MS = 20_000;
export const HOSTINGER_MAX_RESPONSE_BYTES = 512 * 1024;

/** Refusal from this module, kept structural so callers can branch on it. */
export class HostingerTransportConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HostingerTransportConfigError";
	}
}

/**
 * The Hostinger guard policy. A function rather than a constant so a caller
 * always receives the frozen policy this package stands behind and can never
 * mutate a shared object out from under another caller.
 */
export function hostingerTransportPolicy(): TransportGuardPolicy {
	return Object.freeze({
		allowedHosts: Object.freeze([HOSTINGER_API_HOST]),
		allowedPathPrefixes: HOSTINGER_ALLOWED_PATH_PREFIXES,
		maxTimeoutMs: HOSTINGER_MAX_TIMEOUT_MS,
		maxResponseBytes: HOSTINGER_MAX_RESPONSE_BYTES,
	});
}

/**
 * Wrap an injected transport with the Hostinger policy. This is the only
 * transport the resolvers should ever be handed; passing an unguarded one is
 * legal TypeScript and a security defect.
 */
export function guardedHostingerTransport(inner: HttpTransport): HttpTransport {
	return guardTransport(inner, hostingerTransportPolicy());
}

/**
 * Build an absolute Hostinger API URL.
 *
 * Callers pass an already-encoded path (and query); this only joins, so a
 * caller that forgets to encode a name gets a URL the guard will judge, not a
 * silently repaired one.
 */
export function hostingerApiUrl(path: string): string {
	const suffix = path.startsWith("/") ? path : `/${path}`;
	if (
		!HOSTINGER_ALLOWED_PATH_PREFIXES.some((prefix) => suffix.startsWith(prefix))
	) {
		throw new HostingerTransportConfigError(
			`hostinger api path ${JSON.stringify(path)} is outside the allowlisted namespaces (${HOSTINGER_ALLOWED_PATH_PREFIXES.join(", ")}); ${HOSTINGER_EXCLUDED_PATH_PREFIXES.billing.prefix} in particular is excluded because ${HOSTINGER_EXCLUDED_PATH_PREFIXES.billing.reason}`,
		);
	}
	return `https://${HOSTINGER_API_HOST}${suffix}`;
}
