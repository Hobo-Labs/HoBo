/**
 * Typed refusals of the npm realizer.
 *
 * Every refusal is a core `ResolverError` so the reconciler that drives this
 * package through the `ResourceResolver` port needs no npm-specific catch. The
 * one npm-specific addition is `NpmVersionConflictError`: npm versions are
 * immutable, so a registry that already holds different bytes under the
 * desired version is not drift to repair but a conflict to report. It keeps
 * the port's `RESOLVER_PROVIDER_REJECTED` code and adds a closed `reason`.
 *
 * Messages never carry credential material (I9): no token, no ID token, no
 * response body. A registry error body can echo request headers, so bodies are
 * never quoted.
 */
import { ResolverError, type ResolverErrorCode } from "@hobo/core";

// public-contract: the npm package-version product id, keyed by the resolver registry.
export const NPM_PACKAGE_VERSION_PRODUCT_ID = "npm.package-version/v1";
// public-contract: provider id stamped on the resolver.
export const NPM_PROVIDER_ID = "npm";

// public-contract: closed reasons for an immutable-version conflict.
export const NPM_CONFLICT_REASONS = Object.freeze([
	"npm-version-integrity-mismatch",
	"npm-version-previously-unpublished",
] as const);
export type NpmConflictReason = (typeof NPM_CONFLICT_REASONS)[number];

/** The registry holds (or held) different bytes under the desired version. */
export class NpmVersionConflictError extends ResolverError {
	readonly reason: NpmConflictReason;

	constructor(reason: NpmConflictReason, message: string) {
		super(
			"RESOLVER_PROVIDER_REJECTED",
			`${message}. npm versions are immutable and HoBo never overwrites one. Remediation: publish the Freight under a new version`,
			NPM_PACKAGE_VERSION_PRODUCT_ID,
		);
		this.name = "NpmVersionConflictError";
		this.reason = reason;
	}
}

export function fail(
	code: ResolverErrorCode,
	message: string,
	remediation?: string,
): never {
	throw new ResolverError(
		code,
		remediation ? `${message}. Remediation: ${remediation}` : message,
		NPM_PACKAGE_VERSION_PRODUCT_ID,
	);
}

export function reject(message: string, remediation?: string): never {
	fail("RESOLVER_PROVIDER_REJECTED", message, remediation);
}

export function unparseable(message: string): never {
	fail("RESOLVER_OUTPUT_UNPARSEABLE", message);
}

export function unsupported(message: string, remediation: string): never {
	fail("RESOLVER_PRODUCT_UNSUPPORTED", message, remediation);
}

/**
 * The typed refusal for any product this package does not resolve. Unpublish
 * is named explicitly: it is the operation callers most often expect from an
 * npm adapter, and it is refused by policy rather than by omission.
 */
export function npmProductRefusal(productId: string): ResolverError {
	return new ResolverError(
		"RESOLVER_PRODUCT_UNSUPPORTED",
		productId === "npm.package-unpublish/v1"
			? "npm unpublish is refused by policy: it breaks every lockfile that pinned the version and frees nothing (the version can never be reused). Remediation: delete the npm.package-version/v1 resource, which deprecates the version"
			: `the npm realizer resolves only ${NPM_PACKAGE_VERSION_PRODUCT_ID}, not ${JSON.stringify(productId)}. Remediation: route the product to the provider package that owns it`,
		productId,
	);
}
