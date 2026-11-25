/**
 * The signing-secret locator parse boundary.
 *
 * ADR-0113 says the app never holds signing material, and ADR-0161 records this
 * as the deliberate divergence from Alchemy — which persists a generated random
 * secret into its own state file. HoBo brokers the secret instead, so the only
 * thing an authored Better Auth config may carry is a *locator*: a
 * `scheme://authority/path` URI naming where custody lives.
 *
 * This module exists so "is this a locator or is this the secret itself?" has
 * exactly one answer, computed once, at the edge. Anything value-shaped — a
 * connection string, a bearer token, a PEM private key, a JWT, embedded
 * userinfo, or a bare opaque string with no scheme — is refused as an inline
 * secret rather than stored and later leaked into a plan, event, or log line.
 *
 * `@hobo/bindings` owns the platform-wide `SecretRef` parser with the same
 * registered scheme set. An adapter may not import another layer-3 package
 * (see the boundary rules in AGENTS.md), so the scheme list is mirrored here
 * and pinned by a test; it is a shared vocabulary, not a forked mechanism.
 */

import { BetterAuthConfigError } from "./errors.js";
import { isJsonString } from "./json.js";

declare const secretRefBrand: unique symbol;

/** A locator for brokered signing material. Never the material itself. */
export type BetterAuthSecretRef = string & {
	readonly [secretRefBrand]: "BetterAuthSecretRef";
};

/** Registered locator schemes, mirroring `@hobo/bindings` `SECRET_REF_SCHEMES`. */
export const BETTER_AUTH_SECRET_REF_SCHEMES = Object.freeze([
	"aws-sm",
	"azure-kv",
	"gcp-sm",
	"hobo-secret",
	"hobo-token",
	"infisical",
	"op",
	"vault",
] as const);

export type BetterAuthSecretRefScheme =
	(typeof BETTER_AUTH_SECRET_REF_SCHEMES)[number];

const MAX_LOCATOR_LENGTH = 2048;

/** C0 controls and DEL. Scanned rather than matched by regex: a control
 * character inside a regex literal is itself a lint hazard, and a locator that
 * carries one is almost always a log-forging attempt. */
function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/** Shapes that prove a plaintext credential was passed where a locator belongs. */
const INLINE_SECRET_MARKERS: readonly RegExp[] = Object.freeze([
	/^postgres(?:ql)?:\/\//iu,
	/^mysql:\/\//iu,
	/^mongodb(?:\+srv)?:\/\//iu,
	/^rediss?:\/\//iu,
	/^amqps?:\/\//iu,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
	/^Bearer\s+\S+/iu,
	/^(?:sk|pk|ghp|gho|xox[abpsr])[-_][A-Za-z0-9_-]{8,}/u,
	/^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./u,
]);

const REMEDIATE_INLINE =
	'deposit the signing secret into brokered custody and reference it, e.g. secretRef: "hobo-secret://camp/auth/better-auth-signing-key"; HoBo never stores signing material in an authored config';

const REMEDIATE_CONTRACT = `secretRef must be a <scheme>://<authority>/<path> locator using one of: ${BETTER_AUTH_SECRET_REF_SCHEMES.join(", ")}`;

function refuseInline(message: string): never {
	// The offending input is never interpolated — it is probably a live secret.
	throw new BetterAuthConfigError(
		"BETTER_AUTH_SECRET_INLINE",
		message,
		REMEDIATE_INLINE,
	);
}

function refuseLocator(message: string): never {
	throw new BetterAuthConfigError(
		"BETTER_AUTH_SECRET_REF_INVALID",
		message,
		REMEDIATE_CONTRACT,
	);
}

/**
 * Parse a `secretRef` string into a branded {@link BetterAuthSecretRef}.
 *
 * Throws {@link BetterAuthConfigError} with `BETTER_AUTH_SECRET_INLINE` when the
 * input looks like a value, and `BETTER_AUTH_SECRET_REF_INVALID` when it is
 * locator-shaped but malformed or in an unregistered scheme.
 */
export function parseBetterAuthSecretRef<T>(input: T): BetterAuthSecretRef {
	if (!isJsonString(input) || input.length === 0) {
		refuseLocator("secretRef must be a non-empty string locator");
	}
	const locator = `${input}`;
	if (locator.length > MAX_LOCATOR_LENGTH) {
		refuseLocator(
			`secretRef exceeds the ${MAX_LOCATOR_LENGTH} character locator limit`,
		);
	}
	if (hasControlCharacter(locator)) {
		refuseLocator("secretRef contains control characters");
	}
	for (const marker of INLINE_SECRET_MARKERS) {
		if (marker.test(locator)) {
			refuseInline(
				"secretRef looks like a plaintext credential, not a custody locator",
			);
		}
	}

	const separator = locator.indexOf("://");
	if (separator <= 0) {
		// No scheme at all: an opaque string here is the secret itself.
		refuseInline("secretRef carries no locator scheme, so it reads as a value");
	}

	const scheme = locator.slice(0, separator);
	if (scheme !== scheme.toLowerCase()) {
		refuseLocator("secretRef scheme must be lowercase");
	}
	// SAFETY: assertion to `UTH_SECRET_REF_SCHEMES as readonly string[]).includ` is required at this boundary.
	if (!(BETTER_AUTH_SECRET_REF_SCHEMES as readonly string[]).includes(scheme)) {
		refuseLocator(
			`secretRef scheme ${JSON.stringify(scheme)} is not registered`,
		);
	}

	const rest = locator.slice(separator + 3);
	const firstSlash = rest.indexOf("/");
	if (firstSlash <= 0) {
		refuseLocator("secretRef must name an authority and a path");
	}
	const authority = rest.slice(0, firstSlash);
	const pathAndFragment = rest.slice(firstSlash + 1);
	if (authority.includes("@")) {
		refuseInline("secretRef authority embeds userinfo credentials");
	}
	if (/\s/u.test(rest)) {
		refuseLocator("secretRef contains whitespace");
	}
	if (pathAndFragment.length === 0) {
		refuseLocator("secretRef path segment is empty");
	}

	const [path = "", ...extraFragments] = pathAndFragment.split("#");
	if (extraFragments.length > 1) {
		refuseLocator("secretRef carries more than one fragment separator");
	}
	if (path.length === 0) {
		refuseLocator("secretRef path segment is empty");
	}
	if (path.includes("?")) {
		refuseLocator("secretRef path must not carry a query string");
	}
	for (const segment of path.split("/")) {
		if (segment === "" || segment === "." || segment === "..") {
			refuseLocator(
				"secretRef path must not contain empty or traversal segments",
			);
		}
	}

	// SAFETY: assertion to ` BetterAuthSecretRef; } /**` is required at this boundary.
	return locator as BetterAuthSecretRef;
}

/** The scheme half of an already-parsed locator. */
export function betterAuthSecretRefScheme(
	ref: BetterAuthSecretRef,
): BetterAuthSecretRefScheme {
	const separator = ref.indexOf("://");
	// SAFETY: assertion to `e(0, separator) as BetterAuthSecretRefScheme; } ` is required at this boundary.
	return ref.slice(0, separator) as BetterAuthSecretRefScheme;
}
