/**
 * Typed refusals of the GitHub Pages realizer.
 *
 * Every refusal is a core `ResolverError`, so the reconciler driving this
 * package through the `ResourceResolver` port needs no GitHub-specific catch.
 * `GithubPagesRefusal` adds one closed `reason` on top of the port's code, so
 * remediation can branch on *why* (Pages disabled, a missing permission, a
 * branch that moved under us) without parsing a message.
 *
 * Messages never carry credential material (I9): no token, no OIDC token, no
 * response body. A GitHub error body can echo request details, so bodies are
 * never quoted.
 */
import { ResolverError, type ResolverErrorCode } from "@hobo/core";

// public-contract: the GitHub Pages site product id, keyed by the resolver registry.
export const GITHUB_PAGES_SITE_PRODUCT_ID = "github.pages-site/v1";
// public-contract: provider id stamped on the resolver.
export const GITHUB_PROVIDER_ID = "github";

// public-contract: closed reasons a GitHub Pages reconcile refuses with.
export const GITHUB_PAGES_REFUSAL_REASONS = Object.freeze([
	"github-credential-rejected",
	"github-permission-missing",
	"github-rate-limited",
	"github-pages-disabled",
	"github-pages-source-mismatch",
	"github-ref-not-fast-forward",
	"github-pages-build-errored",
	"github-pages-deployment-failed",
	"github-pages-artifact-unavailable",
] as const);
export type GithubPagesRefusalReason =
	(typeof GITHUB_PAGES_REFUSAL_REASONS)[number];

const CODE_OF: Readonly<Record<GithubPagesRefusalReason, ResolverErrorCode>> =
	Object.freeze({
		"github-credential-rejected": "RESOLVER_CREDENTIAL_MISSING",
		"github-permission-missing": "RESOLVER_PROVIDER_REJECTED",
		"github-rate-limited": "RESOLVER_PROVIDER_REJECTED",
		"github-pages-disabled": "RESOLVER_PROVIDER_REJECTED",
		"github-pages-source-mismatch": "RESOLVER_PROVIDER_REJECTED",
		"github-ref-not-fast-forward": "RESOLVER_PROVIDER_REJECTED",
		"github-pages-build-errored": "RESOLVER_PROVIDER_REJECTED",
		"github-pages-deployment-failed": "RESOLVER_PROVIDER_REJECTED",
		"github-pages-artifact-unavailable": "RESOLVER_PRODUCT_UNSUPPORTED",
	});

/** A GitHub-side precondition or outcome that blocks convergence. */
export class GithubPagesRefusal extends ResolverError {
	readonly reason: GithubPagesRefusalReason;

	constructor(
		reason: GithubPagesRefusalReason,
		message: string,
		remediation: string,
	) {
		super(
			CODE_OF[reason],
			`${message}. Remediation: ${remediation}`,
			GITHUB_PAGES_SITE_PRODUCT_ID,
		);
		this.name = "GithubPagesRefusal";
		this.reason = reason;
	}
}

export function refuse(
	reason: GithubPagesRefusalReason,
	message: string,
	remediation: string,
): never {
	throw new GithubPagesRefusal(reason, message, remediation);
}

export function fail(
	code: ResolverErrorCode,
	message: string,
	remediation?: string,
): never {
	throw new ResolverError(
		code,
		remediation ? `${message}. Remediation: ${remediation}` : message,
		GITHUB_PAGES_SITE_PRODUCT_ID,
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

/** The typed refusal for any product this package does not resolve. */
export function githubProductRefusal(productId: string): ResolverError {
	return new ResolverError(
		"RESOLVER_PRODUCT_UNSUPPORTED",
		`the GitHub realizer resolves only ${GITHUB_PAGES_SITE_PRODUCT_ID}, not ${JSON.stringify(productId)}. Remediation: route the product to the provider package that owns it`,
		productId,
	);
}
