/**
 * The Hetzner-scoped guard policy for the injected HTTP transport.
 *
 * Why this module exists: the resolvers in `./resolvers.ts` call the Hetzner
 * Cloud API directly — there is no IaC engine in the middle — and every one of
 * those requests carries a live project API token in its `authorization`
 * header. A driver that trusts whatever transport (and whatever URL) it is
 * handed can be pointed at an attacker's origin by one bad config value, and
 * the token goes with it. So the transport is always injected, and the policy
 * below is what makes an injected transport safe on this path: HTTPS only, one
 * exact host, one path prefix, no redirect chasing, bounded body, bounded time.
 * Enforcement itself lives in `guardTransport()` in `@hobo/core`; this module
 * owns only the Hetzner-specific numbers and hosts, so the rule set cannot
 * drift per provider package.
 *
 * Hetzner splits its surfaces across four products with three different
 * credentials, and one of them is deliberately left out:
 *
 *   - **Cloud API** (`api.hetzner.cloud/v1`) — project API token, allowlisted.
 *   - **Unified API** (`api.hetzner.com/v1`) — the newer host that carries the
 *     surfaces Hetzner has migrated off Robot, Storage Boxes among them. Same
 *     bearer-token scheme as the Cloud API, different origin, so it gets its
 *     own policy rather than a widened host list: a policy naming two hosts
 *     would let a Cloud API path be requested from the unified origin and vice
 *     versa, and the guard would have nothing to say about it.
 *   - **Object Storage** (`<location>.your-objectstorage.com`) — an S3 surface
 *     signed with SigV4 against a *separate* access key pair. It has its own
 *     policy below (`objectStorageTransportPolicy`) rather than riding on the
 *     Cloud API's, so a project token can never be sent to it and an S3 key can
 *     never be sent to the Cloud API.
 *   - **Robot** (`robot-ws.your-server.de`) — dedicated-server administration
 *     behind HTTP Basic with the account's web credentials. Reaching it would
 *     mean sending a *console password* from a resolver, so it is not
 *     allowlisted. Nothing this package catalogs needs it.
 *
 * Nothing here reaches for a global `fetch`. Reaching the network is always
 * something a host decided to hand over, never something a library reached for.
 *
 * HONEST SCOPE: the guard constrains the request this package composes and the
 * response it accepts. It cannot prove the injected transport honours
 * `timeoutMs`, refuses to follow a 302 itself, or terminates TLS against the
 * real Hetzner certificate — those are the host's obligations. Passing the
 * guard is not evidence that a live call was made.
 */

import {
	guardTransport,
	type HttpTransport,
	type TransportGuardPolicy,
} from "@hobo/core";

// public-contract: the single host every Hetzner Cloud control-plane call reaches.
export const HETZNER_API_HOST = "api.hetzner.cloud";

// public-contract: the path allowlist for the Hetzner transport guard.
export const HETZNER_ALLOWED_PATH_PREFIXES = Object.freeze(["/v1/"] as const);

/**
 * Hosts this package deliberately does **not** allowlist, and why. Exported so
 * the reason travels with the code rather than living only in a comment: a
 * future contributor adding an Object Storage resolver should have to read
 * this before widening the policy.
 */
// public-contract: the named non-allowlisted Hetzner surfaces; widening the guard to any of them changes which credential can leave this package.
export const HETZNER_EXCLUDED_SURFACES = Object.freeze({
	robot: Object.freeze({
		hostPattern: "robot-ws.your-server.de",
		credential: "HTTP Basic with the account's web console password",
		reason:
			"dedicated-server administration only. Every product this package catalogs is reachable with a scoped API token on one of the allowlisted hosts, so nothing here needs a surface authenticated by the password that also opens the web console",
	}),
});

/**
 * Caps. These are control-plane calls: small bodies, quick answers. A response
 * larger or slower than this is a contract change, not a big success.
 */
export const HETZNER_MAX_TIMEOUT_MS = 20_000;
export const HETZNER_MAX_RESPONSE_BYTES = 512 * 1024;

/** Refusal from this module, kept structural so callers can branch on it. */
export class HetznerTransportConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HetznerTransportConfigError";
	}
}

/**
 * The Hetzner guard policy. A function rather than a constant so a caller
 * always receives the frozen policy this package stands behind and can never
 * mutate a shared object out from under another caller.
 */
export function hetznerTransportPolicy(): TransportGuardPolicy {
	return Object.freeze({
		allowedHosts: Object.freeze([HETZNER_API_HOST]),
		allowedPathPrefixes: HETZNER_ALLOWED_PATH_PREFIXES,
		maxTimeoutMs: HETZNER_MAX_TIMEOUT_MS,
		maxResponseBytes: HETZNER_MAX_RESPONSE_BYTES,
	});
}

/**
 * The unified API host.
 *
 * Hetzner has been consolidating surfaces that used to live on Robot onto
 * `api.hetzner.com`, authenticated with the same kind of scoped API token the
 * Cloud API takes. Storage Boxes are on it: `GET|POST /v1/storage_boxes` and
 * `GET|PUT|DELETE /v1/storage_boxes/{id}`, with the same `?name=` exact filter
 * and the same `{ storage_boxes: [...] }` envelope the Cloud API uses.
 */
// public-contract: the host carrying Hetzner surfaces migrated off Robot; Storage Boxes live here.
export const HETZNER_UNIFIED_API_HOST = "api.hetzner.com";

// public-contract: the path allowlist for the Hetzner unified-API transport guard.
export const HETZNER_UNIFIED_ALLOWED_PATH_PREFIXES = Object.freeze([
	"/v1/storage_boxes",
	"/v1/storage_box_types",
] as const);

/**
 * The guard policy for the unified API.
 *
 * The prefix list is narrower than the Cloud API's `/v1/`: this package uses
 * the host for Storage Boxes and nothing else, and a guard that admits only
 * what is used is the one that makes a later widening visible in review.
 */
export function hetznerUnifiedApiTransportPolicy(): TransportGuardPolicy {
	return Object.freeze({
		allowedHosts: Object.freeze([HETZNER_UNIFIED_API_HOST]),
		allowedPathPrefixes: HETZNER_UNIFIED_ALLOWED_PATH_PREFIXES,
		maxTimeoutMs: HETZNER_MAX_TIMEOUT_MS,
		maxResponseBytes: HETZNER_MAX_RESPONSE_BYTES,
	});
}

/** Wrap an injected transport with the unified-API policy. */
export function guardedHetznerUnifiedApiTransport(
	inner: HttpTransport,
): HttpTransport {
	return guardTransport(inner, hetznerUnifiedApiTransportPolicy());
}

/**
 * Build an absolute unified-API URL. Callers pass an already-encoded path, so
 * a caller that forgets to encode a name gets a URL the guard will judge
 * rather than a silently repaired one.
 */
export function hetznerUnifiedApiUrl(path: string): string {
	const suffix = path.startsWith("/") ? path : `/${path}`;
	if (
		!HETZNER_UNIFIED_ALLOWED_PATH_PREFIXES.some((prefix) =>
			suffix.startsWith(prefix),
		)
	) {
		throw new HetznerTransportConfigError(
			`hetzner unified api path ${JSON.stringify(path)} is outside the allowlisted prefixes (${HETZNER_UNIFIED_ALLOWED_PATH_PREFIXES.join(", ")}); a path outside them would be refused at the transport with a less useful message`,
		);
	}
	return `https://${HETZNER_UNIFIED_API_HOST}${suffix}`;
}

/** Object Storage locations, which are the Cloud locations that offer it. */
export const OBJECT_STORAGE_LOCATIONS = Object.freeze([
	"fsn1",
	"nbg1",
	"hel1",
] as const);

export type ObjectStorageLocation = (typeof OBJECT_STORAGE_LOCATIONS)[number];

/**
 * The Object Storage origin for one location.
 *
 * This is an S3 surface, not the Cloud API: a different host, a *different
 * credential* (an Object Storage key pair), and SigV4 rather than a bearer
 * token. It gets its own policy for exactly that reason — one policy covering
 * both would let a project API token be sent to an Object Storage endpoint, or
 * an S3 key to the Cloud API.
 */
function isObjectStorageLocation(
	location: string,
): location is ObjectStorageLocation {
	for (const known of OBJECT_STORAGE_LOCATIONS) {
		if (known === location) return true;
	}
	return false;
}

export function objectStorageHost(location: string): string {
	if (!isObjectStorageLocation(location)) {
		throw new HetznerTransportConfigError(
			`hetzner object storage location ${JSON.stringify(location)} is not one of ${OBJECT_STORAGE_LOCATIONS.join(", ")}; a location that does not parse would be interpolated into a hostname nobody allowlisted`,
		);
	}
	return `${location}.your-objectstorage.com`;
}

/**
 * The guard policy for one Object Storage location. One host, and the root
 * prefix — S3 addresses a bucket and key as the whole path, so there is no
 * narrower prefix that admits an ordinary object without admitting its
 * siblings. The host list is what constrains reach here.
 */
export function objectStorageTransportPolicy(
	location: string,
): TransportGuardPolicy {
	return Object.freeze({
		allowedHosts: Object.freeze([objectStorageHost(location)]),
		allowedPathPrefixes: Object.freeze(["/"]),
		maxTimeoutMs: HETZNER_MAX_TIMEOUT_MS,
		maxResponseBytes: HETZNER_MAX_RESPONSE_BYTES,
	});
}

/** Wrap an injected transport with one Object Storage location's policy. */
export function guardedObjectStorageTransport(
	inner: HttpTransport,
	location: string,
): HttpTransport {
	return guardTransport(inner, objectStorageTransportPolicy(location));
}

/** An absolute Object Storage URL. Callers pass an already-encoded path. */
export function objectStorageUrl(location: string, path: string): string {
	const suffix = path.startsWith("/") ? path : `/${path}`;
	return `https://${objectStorageHost(location)}${suffix}`;
}

/**
 * Wrap an injected transport with the Hetzner policy. This is the only
 * transport the resolvers should ever be handed; passing an unguarded one is
 * legal TypeScript and a security defect.
 */
export function guardedHetznerTransport(inner: HttpTransport): HttpTransport {
	return guardTransport(inner, hetznerTransportPolicy());
}

/**
 * Build an absolute Hetzner Cloud API URL.
 *
 * Callers pass an already-encoded path (and query); this only joins, so a
 * caller that forgets to encode a name gets a URL the guard will judge, not a
 * silently repaired one.
 */
export function hetznerApiUrl(path: string): string {
	const suffix = path.startsWith("/") ? path : `/${path}`;
	if (!suffix.startsWith("/v1/")) {
		throw new HetznerTransportConfigError(
			`hetzner api path ${JSON.stringify(path)} does not start with /v1/; the guard allowlists that prefix only, and a path outside it would be refused at the transport with a less useful message`,
		);
	}
	return `https://${HETZNER_API_HOST}${suffix}`;
}
