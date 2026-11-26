/**
 * The one error this package throws. Its message names what failed and why
 * in HoBo's words: never a claim URL, a token, a password or a provider's
 * response body.
 */

export const SECRET_STORE_ERROR_CODES = [
	/** No offer passed its hard gates; the selection names why for each. */
	"SECRET_STORE_NO_OFFER",
	/** An offer, evidence or binding record failed its parser. */
	"SECRET_STORE_INVALID",
	/** The human has not accepted a provider's terms the offer needs. */
	"SECRET_STORE_CONSENT_REQUIRED",
	/** A provider call failed; the cause is a typed provider error. */
	"SECRET_STORE_PROVIDER_FAILED",
	/** The store exists but the relay cannot read it yet (runtime binding designed only). */
	"SECRET_STORE_RUNTIME_BINDING_UNBUILT",
	/**
	 * GitHub did not say which OIDC subject the repository's tokens carry, so
	 * no workload trust is written (fail closed rather than guess a format).
	 */
	"SECRET_STORE_OIDC_SUBJECT_UNRESOLVED",
	/** Ownership could not be verified through the provider. */
	"SECRET_STORE_CLAIM_UNVERIFIED",
] as const;

export type SecretStoreErrorCode = (typeof SECRET_STORE_ERROR_CODES)[number];

export class SecretStoreError extends Error {
	readonly code: SecretStoreErrorCode;
	constructor(code: SecretStoreErrorCode, message: string) {
		super(message);
		this.name = "SecretStoreError";
		this.code = code;
	}
}

export function secretStoreError(
	code: SecretStoreErrorCode,
	message: string,
): never {
	throw new SecretStoreError(code, message);
}
