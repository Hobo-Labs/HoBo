/**
 * The DigitalOcean-scoped guard policy for the injected HTTP transport.
 *
 * Why this module exists: the resolvers in `./resolvers.ts` call the
 * DigitalOcean API directly — there is no IaC engine in the middle — and every
 * one of those requests carries a live personal access token in its
 * `authorization` header. A driver that trusts whatever transport (and whatever
 * URL) it is handed can be pointed at an attacker's origin by one bad config
 * value, and the token goes with it. So the transport is always injected, and
 * the policy below is what makes an injected transport safe on this path:
 * HTTPS only, one exact host, one path prefix, no redirect chasing, bounded
 * body, bounded time. Enforcement itself lives in `guardTransport()` in
 * `@hobo/core`; this module owns only the DigitalOcean-specific numbers and
 * hosts, so the rule set cannot drift per provider package.
 *
 * DigitalOcean is the easy case for a guard and this module does not pretend
 * otherwise: the whole v2 control plane is one host and one prefix, so the
 * policy is a constant rather than something built per region. The one API
 * surface that is *not* on this host is Spaces, which speaks S3 on
 * `<region>.digitaloceanspaces.com` with SigV4 — a different host, a different
 * signature, and therefore deliberately not allowlisted here. That is why
 * `digitalocean.spaces/v1` ships no resolver rather than a resolver reaching a
 * host this policy would have to be widened for.
 *
 * Nothing here reaches for a global `fetch`. Reaching the network is always
 * something a host decided to hand over, never something a library reached for.
 *
 * HONEST SCOPE: the guard constrains the request this package composes and the
 * response it accepts. It cannot prove the injected transport honours
 * `timeoutMs`, refuses to follow a 302 itself, or terminates TLS against the
 * real DigitalOcean certificate — those are the host's obligations. Passing the
 * guard is not evidence that a live call was made.
 */

import {
	guardTransport,
	type HttpTransport,
	type TransportGuardPolicy,
} from "@hobo/core";

// public-contract: the single host every DigitalOcean control-plane call reaches.
export const DIGITALOCEAN_API_HOST = "api.digitalocean.com";

// public-contract: the path allowlist for the DigitalOcean transport guard.
export const DIGITALOCEAN_ALLOWED_PATH_PREFIXES = Object.freeze([
	"/v2/",
] as const);

/**
 * Caps. These are control-plane calls: small bodies, quick answers. A response
 * larger or slower than this is a contract change, not a big success.
 */
export const DIGITALOCEAN_MAX_TIMEOUT_MS = 20_000;
export const DIGITALOCEAN_MAX_RESPONSE_BYTES = 512 * 1024;

/** Refusal from this module, kept structural so callers can branch on it. */
export class DigitalOceanTransportConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DigitalOceanTransportConfigError";
	}
}

/**
 * The DigitalOcean guard policy. A function rather than a constant so a caller
 * always receives the frozen policy this package stands behind and can never
 * mutate a shared object out from under another caller.
 */
export function digitaloceanTransportPolicy(): TransportGuardPolicy {
	return Object.freeze({
		allowedHosts: Object.freeze([DIGITALOCEAN_API_HOST]),
		allowedPathPrefixes: DIGITALOCEAN_ALLOWED_PATH_PREFIXES,
		maxTimeoutMs: DIGITALOCEAN_MAX_TIMEOUT_MS,
		maxResponseBytes: DIGITALOCEAN_MAX_RESPONSE_BYTES,
	});
}

/**
 * The Spaces origin for one region. Spaces is S3, not the v2 control plane: a
 * different host, a different credential (a Spaces key pair), and SigV4 rather
 * than a bearer token. It gets its own policy for exactly that reason — folding
 * it into the control-plane policy would let a personal access token be sent to
 * a Spaces endpoint and vice versa.
 */
export function spacesHost(region: string): string {
	if (!/^[a-z]{2,4}[0-9]$/u.test(region)) {
		throw new DigitalOceanTransportConfigError(
			`digitalocean spaces region ${JSON.stringify(region)} is not a datacenter slug such as "nyc3"; a region that does not parse would be interpolated into a hostname nobody allowlisted`,
		);
	}
	return `${region}.digitaloceanspaces.com`;
}

/**
 * The guard policy for one Spaces region. One host, and the root prefix —
 * S3 addresses a bucket and key as the whole path, so there is no narrower
 * prefix that admits an ordinary object without admitting its siblings. The
 * host list is what constrains reach here, and this comment says so rather
 * than implying the path check is doing work it is not.
 */
export function spacesTransportPolicy(region: string): TransportGuardPolicy {
	return Object.freeze({
		allowedHosts: Object.freeze([spacesHost(region)]),
		allowedPathPrefixes: Object.freeze(["/"]),
		maxTimeoutMs: DIGITALOCEAN_MAX_TIMEOUT_MS,
		maxResponseBytes: DIGITALOCEAN_MAX_RESPONSE_BYTES,
	});
}

/** Wrap an injected transport with one Spaces region's policy. */
export function guardedSpacesTransport(
	inner: HttpTransport,
	region: string,
): HttpTransport {
	return guardTransport(inner, spacesTransportPolicy(region));
}

/** An absolute Spaces URL. Callers pass an already-encoded bucket path. */
export function spacesUrl(region: string, path: string): string {
	const suffix = path.startsWith("/") ? path : `/${path}`;
	return `https://${spacesHost(region)}${suffix}`;
}

/**
 * A Functions namespace's own API host.
 *
 * DigitalOcean Functions has two layers, and only the outer one lives on
 * `api.digitalocean.com`. `/v2/functions/namespaces` manages *namespaces*, and
 * each namespace record carries an `api_host` of the form
 * `faas-<region>-<id>.doserverless.co` serving an OpenWhisk-compatible API —
 * that is where an individual function is created, read and deleted.
 *
 * The host is therefore not a constant this package can allowlist ahead of
 * time. It is still an *exact* host at call time: the resolver reads it from
 * DigitalOcean's own control plane rather than from `desired`, this function
 * refuses anything that is not shaped like a Functions host, and the policy
 * built from it names that one host and nothing else. A pattern decides whether
 * a host is admissible; the guard still enforces one literal host per request.
 */
const FUNCTIONS_HOST_PATTERN =
	/^faas-[a-z]{2,4}[0-9]{1,2}-[0-9a-f]{4,32}\.doserverless\.co$/u;

// public-contract: the path allowlist for a Functions namespace transport guard.
export const DIGITALOCEAN_FUNCTIONS_ALLOWED_PATH_PREFIXES = Object.freeze([
	"/api/v1/namespaces/",
] as const);

/** Parse a namespace `api_host` (URL or bare host) into a bare host. */
export function functionsHost(apiHost: string): string {
	const bare = apiHost.startsWith("https://")
		? apiHost.slice("https://".length).replace(/\/+$/u, "")
		: apiHost.replace(/\/+$/u, "");
	if (!FUNCTIONS_HOST_PATTERN.test(bare)) {
		throw new DigitalOceanTransportConfigError(
			`digitalocean functions api_host ${JSON.stringify(apiHost)} is not shaped like a Functions namespace host (faas-<region>-<id>.doserverless.co); a host that does not parse would be dialled with the namespace's credentials on the strength of whatever returned it`,
		);
	}
	return bare;
}

/**
 * The guard policy for one Functions namespace host. One exact host, and the
 * namespace prefix — a function is addressed as
 * `/api/v1/namespaces/{namespace}/actions/{name}`.
 */
export function functionsTransportPolicy(
	apiHost: string,
): TransportGuardPolicy {
	return Object.freeze({
		allowedHosts: Object.freeze([functionsHost(apiHost)]),
		allowedPathPrefixes: DIGITALOCEAN_FUNCTIONS_ALLOWED_PATH_PREFIXES,
		maxTimeoutMs: DIGITALOCEAN_MAX_TIMEOUT_MS,
		maxResponseBytes: DIGITALOCEAN_MAX_RESPONSE_BYTES,
	});
}

/** Wrap an injected transport with one Functions namespace's policy. */
export function guardedFunctionsTransport(
	inner: HttpTransport,
	apiHost: string,
): HttpTransport {
	return guardTransport(inner, functionsTransportPolicy(apiHost));
}

/** An absolute Functions URL. Callers pass an already-encoded path. */
export function functionsUrl(apiHost: string, path: string): string {
	const suffix = path.startsWith("/") ? path : `/${path}`;
	return `https://${functionsHost(apiHost)}${suffix}`;
}

/**
 * Wrap an injected transport with the DigitalOcean policy. This is the only
 * transport the resolvers should ever be handed; passing an unguarded one is
 * legal TypeScript and a security defect.
 */
export function guardedDigitalOceanTransport(
	inner: HttpTransport,
): HttpTransport {
	return guardTransport(inner, digitaloceanTransportPolicy());
}

/**
 * Build an absolute DigitalOcean API URL.
 *
 * Callers pass an already-encoded path (and query); this only joins, so a
 * caller that forgets to encode a name gets a URL the guard will judge, not a
 * silently repaired one.
 */
export function digitaloceanApiUrl(path: string): string {
	const suffix = path.startsWith("/") ? path : `/${path}`;
	if (!suffix.startsWith("/v2/")) {
		throw new DigitalOceanTransportConfigError(
			`digitalocean api path ${JSON.stringify(path)} does not start with /v2/; the guard allowlists that prefix only, and a path outside it would be refused at the transport with a less useful message`,
		);
	}
	return `https://${DIGITALOCEAN_API_HOST}${suffix}`;
}
