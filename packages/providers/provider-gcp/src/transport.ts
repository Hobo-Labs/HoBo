/**
 * The GCP-scoped guard policies for the injected HTTP transport.
 *
 * Why this module exists: the resolvers in `./resolvers.ts` talk to Google's
 * REST APIs directly — there is no IaC engine in the middle — and every one of
 * those requests carries a live OAuth2 access token in its `authorization`
 * header. A driver that trusts whatever transport (and whatever URL) it is
 * handed can be pointed at an attacker's origin by one bad config value, and
 * the token goes with it. So the transport is always injected, and the policies
 * below are what make an injected transport safe on this path: HTTPS only, one
 * exact host, one path prefix, no redirect chasing, bounded body, bounded time.
 * Enforcement itself lives in `guardTransport()` in `@hobo/core`; this module
 * owns only the GCP-specific numbers, so the rule set cannot drift per package.
 *
 * Google splits its control plane across per-service hosts, so the policy is
 * **per service** rather than one policy with a union of hosts and a union of
 * prefixes. A union policy would let a Cloud SQL path be sent to the Cloud
 * Storage host and vice versa — every host paired with every prefix — which is
 * a wider reach than any single call needs. `*.googleapis.com` is deliberately
 * not allowlisted: a wildcard would readmit every Google API at once, and
 * bounding reach is the entire point of the guard.
 *
 * Nothing here reaches for a global `fetch`. Reaching the network is always
 * something a host decided to hand over, never something a library reached for.
 *
 * HONEST SCOPE: the guard constrains the request this package composes and the
 * response it accepts. It cannot prove the injected transport honours
 * `timeoutMs`, refuses to follow a 302 itself, or terminates TLS against the
 * real Google certificate — those are the host's obligations. Passing the guard
 * is not evidence that a live call was made.
 */

import {
	guardTransport,
	type HttpTransport,
	type TransportGuardPolicy,
} from "@hobo/core";

// public-contract: the closed set of Google services these resolvers address; each is a separate host and a separate guard policy.
export const GCP_API_SERVICES = Object.freeze([
	"cloudRun",
	"cloudSql",
	"cloudStorage",
	"cloudTasks",
	"memorystore",
	"pubsub",
	"secretManager",
] as const);

export type GcpApiService = (typeof GCP_API_SERVICES)[number];

/** One service's reachable surface: exactly one host, exactly one prefix. */
export interface GcpApiEndpoint {
	readonly host: string;
	readonly pathPrefix: string;
}

/**
 * The host and path prefix each service is allowed to reach. Written out
 * per service rather than derived, so widening reach is an edit a reviewer can
 * see rather than a pattern that silently matches a new host.
 */
// public-contract: the exact (host, path prefix) pair each resolver family may reach; widening this widens where a live token can be sent.
export const GCP_API_ENDPOINTS: Readonly<
	Record<GcpApiService, GcpApiEndpoint>
> = Object.freeze({
	cloudRun: Object.freeze({
		host: "run.googleapis.com",
		pathPrefix: "/v2/projects/",
	}),
	cloudSql: Object.freeze({
		host: "sqladmin.googleapis.com",
		pathPrefix: "/v1/projects/",
	}),
	cloudStorage: Object.freeze({
		host: "storage.googleapis.com",
		pathPrefix: "/storage/v1/b",
	}),
	cloudTasks: Object.freeze({
		host: "cloudtasks.googleapis.com",
		pathPrefix: "/v2/projects/",
	}),
	memorystore: Object.freeze({
		host: "redis.googleapis.com",
		pathPrefix: "/v1/projects/",
	}),
	pubsub: Object.freeze({
		host: "pubsub.googleapis.com",
		pathPrefix: "/v1/projects/",
	}),
	secretManager: Object.freeze({
		host: "secretmanager.googleapis.com",
		pathPrefix: "/v1/projects/",
	}),
});

/** Every host any GCP resolver can reach, sorted and deduplicated. */
export const GCP_API_ALLOWED_HOSTS: readonly string[] = Object.freeze(
	[
		...new Set(
			Object.values(GCP_API_ENDPOINTS).map((endpoint) => endpoint.host),
		),
	].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
);

/**
 * Caps. These control-plane calls return small documents quickly; a response
 * larger or slower than this is a contract change, not a big success.
 */
export const GCP_MAX_TIMEOUT_MS = 20_000;
export const GCP_MAX_RESPONSE_BYTES = 512 * 1024;

/**
 * The guard policy for one service. A function rather than a constant so a
 * caller always receives the frozen policy this package stands behind and can
 * never mutate a shared object out from under another caller.
 */
export function gcpTransportPolicy(
	service: GcpApiService,
): TransportGuardPolicy {
	const endpoint = endpointFor(service);
	return Object.freeze({
		allowedHosts: Object.freeze([endpoint.host]),
		allowedPathPrefixes: Object.freeze([endpoint.pathPrefix]),
		maxTimeoutMs: GCP_MAX_TIMEOUT_MS,
		maxResponseBytes: GCP_MAX_RESPONSE_BYTES,
	});
}

/**
 * Wrap an injected transport with one service's policy. This is the only
 * transport a resolver should ever send with; passing an unguarded one is legal
 * TypeScript and a security defect.
 */
export function guardedGcpTransport(
	inner: HttpTransport,
	service: GcpApiService,
): HttpTransport {
	return guardTransport(inner, gcpTransportPolicy(service));
}

/**
 * Build an absolute Google API URL for one service.
 *
 * Callers pass already-encoded segments; this only joins, so a caller that
 * forgets `encodeURIComponent` on a name gets a URL the guard will judge, not a
 * silently repaired one.
 */
export function gcpApiUrl(service: GcpApiService, path: string): string {
	const endpoint = endpointFor(service);
	const suffix = path.startsWith("/") ? path : `/${path}`;
	return `https://${endpoint.host}${suffix}`;
}

function endpointFor(service: GcpApiService): GcpApiEndpoint {
	const endpoint = GCP_API_ENDPOINTS[service];
	if (endpoint === undefined) {
		// Unreachable through the exported type; a runtime caller that squeezes
		// an unknown service past it gets a refusal rather than a URL pointing at
		// `https://undefined/…` that the guard would then judge on the wrong facts.
		throw new Error(
			`gcp transport: unknown service ${JSON.stringify(service)}; expected one of ${GCP_API_SERVICES.join(", ")}`,
		);
	}
	return endpoint;
}
