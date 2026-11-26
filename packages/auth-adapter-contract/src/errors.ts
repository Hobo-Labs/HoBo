/**
 * Typed refusals for the Better Auth adapter.
 *
 * Every refusal in this package carries a machine-readable `code` and a
 * human-actionable `remediation` string. That pairing is the whole point: this
 * adapter fails closed (a missing base path, an inline secret, an unknown claim
 * shape, an absent runtime dependency) and a caller that cannot proceed must be
 * told exactly what to change. Messages never interpolate the offending input —
 * a rejected "secret ref" is frequently a leaked plaintext credential.
 */

export const BETTER_AUTH_CONFIG_ERROR_CODES = [
	"BETTER_AUTH_CONFIG_SHAPE_INVALID",
	"BETTER_AUTH_BASE_PATH_INVALID",
	"BETTER_AUTH_SECRET_INLINE",
	"BETTER_AUTH_SECRET_REF_INVALID",
	"BETTER_AUTH_DATABASE_PROFILE_INVALID",
	"BETTER_AUTH_SOCIAL_PROVIDER_INVALID",
	"BETTER_AUTH_UNKNOWN_FIELD",
] as const;

export type BetterAuthConfigErrorCode =
	(typeof BETTER_AUTH_CONFIG_ERROR_CODES)[number];

export class BetterAuthConfigError extends Error {
	readonly code: BetterAuthConfigErrorCode;
	readonly remediation: string;

	constructor(
		code: BetterAuthConfigErrorCode,
		message: string,
		remediation: string,
	) {
		super(message);
		this.name = "BetterAuthConfigError";
		this.code = code;
		this.remediation = remediation;
	}
}

export const BETTER_AUTH_CLAIMS_ERROR_CODES = [
	"BETTER_AUTH_CLAIMS_SHAPE_INVALID",
	"BETTER_AUTH_CLAIMS_SUBJECT_INVALID",
	"BETTER_AUTH_CLAIMS_ISSUER_INVALID",
	"BETTER_AUTH_CLAIMS_EMAIL_INVALID",
	"BETTER_AUTH_CLAIMS_ORGANIZATION_INVALID",
	"BETTER_AUTH_CLAIMS_ROLE_INVALID",
	"BETTER_AUTH_CLAIMS_REGISTERED_CLAIM_INVALID",
	"BETTER_AUTH_CLAIMS_UNKNOWN_FIELD",
] as const;

export type BetterAuthClaimsErrorCode =
	(typeof BETTER_AUTH_CLAIMS_ERROR_CODES)[number];

export class BetterAuthClaimsError extends Error {
	readonly code: BetterAuthClaimsErrorCode;
	readonly remediation: string;

	constructor(
		code: BetterAuthClaimsErrorCode,
		message: string,
		remediation: string,
	) {
		super(message);
		this.name = "BetterAuthClaimsError";
		this.code = code;
		this.remediation = remediation;
	}
}

/**
 * Raised when the Better Auth runtime is asked for but is not installed.
 *
 * This package deliberately does not depend on `better-auth`; executing the
 * auth server is declared by the bundle, not vendored here. Asking for the
 * runtime without it present is refused rather than degraded to a weaker
 * built-in issuer.
 */
export class BetterAuthRuntimeUnavailableError extends Error {
	readonly code = "BETTER_AUTH_RUNTIME_UNAVAILABLE" as const;
	readonly remediation: string;

	constructor(message: string, remediation: string) {
		super(message);
		this.name = "BetterAuthRuntimeUnavailableError";
		this.remediation = remediation;
	}
}
