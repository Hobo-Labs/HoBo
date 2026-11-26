/**
 * The Azure-scoped guard policy for the injected HTTP transport.
 *
 * Why this module exists: the resolvers in `./resolvers.ts` talk to Azure
 * Resource Manager directly — there is no IaC engine in the middle — and every
 * one of those requests carries a live AAD bearer token in its headers. A
 * driver that trusts whatever transport (and whatever URL) it is handed can be
 * pointed at an attacker's origin by one bad config value, and the token goes
 * with it. ARM makes that risk sharper than most providers do, because a
 * long-running operation hands the *provider* control of the next URL the
 * client calls: `Azure-AsyncOperation` and `Location` are response headers, so
 * the poll target is attacker-influenced by construction. The policy below is
 * what makes following one of those headers safe: HTTPS-only, one exact host,
 * one path prefix, no redirect chasing, bounded body, bounded time. The
 * enforcement itself lives in `guardTransport()` in `@hobo/core`; this module
 * owns only the Azure-specific numbers, so the rule set cannot drift per
 * provider package.
 *
 * Nothing here reaches for a global `fetch`. Reaching the network is always
 * something a host decided to hand over, never something a library reached for.
 *
 * ARM's other standing hazard is the mandatory `api-version` query parameter.
 * A call without one is refused by ARM; a call with the *wrong* one silently
 * serializes a different resource model, which is how a field quietly stops
 * being applied. So `azureArmUrl()` takes the version as a required argument
 * rather than defaulting one, and the versions themselves are pinned per
 * resource type as named constants in `./resolvers.ts`.
 *
 * HONEST SCOPE: the guard constrains the request this package composes and the
 * response it accepts. It cannot prove the injected transport honours
 * `timeoutMs`, refuses to follow a 302 itself, or terminates TLS against the
 * real ARM certificate — those are the host's obligations, restated in the
 * README. Passing the guard is not evidence that a live call was made.
 */

import {
	guardTransport,
	type HttpTransport,
	type TransportGuardPolicy,
} from "@hobo/core";

// public-contract: the only origin the Azure resolvers ever address.
export const AZURE_ARM_ORIGIN = "https://management.azure.com";

/** The documented public ARM host. Nothing else is reachable — in particular
 *  no sovereign-cloud endpoint, which would be a different token audience. */
export const AZURE_ARM_ALLOWED_HOSTS = Object.freeze([
	"management.azure.com",
] as const);

export type AzureArmHost = (typeof AZURE_ARM_ALLOWED_HOSTS)[number];

function isAzureArmHost(host: string): host is AzureArmHost {
	for (const known of AZURE_ARM_ALLOWED_HOSTS) {
		if (known === host) return true;
	}
	return false;
}

/**
 * The single subscription-scoped prefix. Every endpoint the resolvers use is
 * `/subscriptions/{subscriptionId}/…`, and so is every ARM async-operation
 * status URL they follow. A URL outside this prefix is either a caller mistake
 * or a redirect target smuggled in through an operation header, and both are
 * refused rather than sent with the bearer token attached.
 */
export const AZURE_ARM_ALLOWED_PATH_PREFIXES = Object.freeze([
	"/subscriptions/",
] as const);

// public-contract: the prefix every resolver path is appended to, and half of the transport path allowlist.
export const AZURE_ARM_BASE_PATH = "/subscriptions";

/**
 * Caps. ARM control-plane reads and writes are small; the *slow* part of an
 * Azure create is the long-running operation, which this package follows as
 * many bounded polls rather than one long request. So a single call slower or
 * larger than this is a contract change, not a big success.
 */
export const AZURE_MAX_TIMEOUT_MS = 30_000;
export const AZURE_MAX_RESPONSE_BYTES = 512 * 1024;

/**
 * The Azure guard policy. A function rather than a constant so a caller always
 * receives the frozen policy this package stands behind and can never mutate a
 * shared object out from under another caller.
 */
export function azureTransportPolicy(): TransportGuardPolicy {
	return Object.freeze({
		allowedHosts: AZURE_ARM_ALLOWED_HOSTS,
		allowedPathPrefixes: AZURE_ARM_ALLOWED_PATH_PREFIXES,
		maxTimeoutMs: AZURE_MAX_TIMEOUT_MS,
		maxResponseBytes: AZURE_MAX_RESPONSE_BYTES,
	});
}

/**
 * Wrap an injected transport with the Azure policy. This is the only transport
 * the resolvers should ever be handed; passing an unguarded one is legal
 * TypeScript and a security defect.
 */
export function guardedAzureTransport(inner: HttpTransport): HttpTransport {
	return guardTransport(inner, azureTransportPolicy());
}

/**
 * Build an absolute ARM URL from a `/subscriptions`-relative path and an
 * explicitly pinned `api-version`.
 *
 * The version is a required argument on purpose: ARM rejects a call that omits
 * it and silently serializes a different resource model for a call that names
 * the wrong one, so a default here would be a guess with correctness
 * consequences. Callers pass already-encoded path segments; this only joins
 * and appends, so a caller that forgets `encodeURIComponent` on a
 * caller-supplied name gets a URL the guard will judge, not a silently
 * repaired one.
 */
export function azureArmUrl(path: string, apiVersion: string): string {
	if (apiVersion.trim().length === 0) {
		throw new TypeError(
			"azureArmUrl: an explicit api-version is required — ARM refuses a call without one and serializes a different resource model for the wrong one",
		);
	}
	const suffix = path.startsWith("/") ? path : `/${path}`;
	const separator = suffix.includes("?") ? "&" : "?";
	return `${AZURE_ARM_ORIGIN}${AZURE_ARM_BASE_PATH}${suffix}${separator}api-version=${encodeURIComponent(apiVersion)}`;
}

/**
 * Accept an ARM-supplied operation URL only if it is on the allowlisted ARM
 * origin, and make sure it carries an `api-version`.
 *
 * ARM returns the next poll target in a response header, so this string is
 * provider-controlled input on the credentialed path. The guard would refuse a
 * foreign host anyway; checking here means the refusal names *why* the URL was
 * rejected instead of surfacing as a generic transport error, and it keeps the
 * bearer token off a URL this package never intended to call.
 *
 * Returns `undefined` when the URL is unusable, so the caller can report the
 * operation honestly as accepted-but-unconfirmed rather than pretend it
 * finished.
 */
export function azureOperationUrl(
	value: string,
	fallbackApiVersion: string,
): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "https:") return undefined;
	if (!isAzureArmHost(parsed.hostname)) {
		return undefined;
	}
	if (!parsed.pathname.startsWith(AZURE_ARM_ALLOWED_PATH_PREFIXES[0])) {
		return undefined;
	}
	if (parsed.searchParams.get("api-version") === null) {
		parsed.searchParams.set("api-version", fallbackApiVersion);
	}
	return parsed.toString();
}
