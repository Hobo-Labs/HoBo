/**
 * Stable HoBo error codes for the Cloudflare temporary-account (claimable edge
 * Yard) path.
 *
 * The codes are the contract: callers branch on `code`, never on message text,
 * and no message ever interpolates provider credential material or a claim URL.
 */

export const TEMPORARY_ACCOUNT_ERROR_CODES = [
	"PROVIDER_RATE_LIMITED",
	"PROVIDER_AUTH_FAILED",
	"PROVIDER_CONTRACT_CHANGED",
	"PROVIDER_OPERATION_AMBIGUOUS",
	"PROVIDER_RESPONSE_TOO_LARGE",
	"PROVIDER_UNAVAILABLE",
	"TRANSPORT_NOT_ALLOWED",
	"CONSENT_REQUIRED",
	"LEASE_EXPIRED",
	"CLAIM_EXPIRED",
	"CLAIM_NOT_VERIFIED",
	"CLAIM_ACTION_CONSUMED",
	"REAUTHORIZATION_REQUIRED",
	"BOOTSTRAP_AUTHORITY_REMAINS",
	"SECRET_CUSTODY_UNAVAILABLE",
	"RESOURCE_NOT_SUPPORTED",
	"WORK_BUDGET_EXCEEDED",
] as const;

export type TemporaryAccountErrorCode =
	(typeof TEMPORARY_ACCOUNT_ERROR_CODES)[number];

/** Codes whose operation may be retried with the same idempotency key. */
const RETRYABLE: ReadonlySet<TemporaryAccountErrorCode> = new Set([
	"PROVIDER_RATE_LIMITED",
	"PROVIDER_UNAVAILABLE",
]);

export type TemporaryAccountErrorOptions = {
	/** Machine-readable sub-reason, e.g. `MISSING_FIELD`, `DUPLICATE_FIELD`. */
	readonly reason?: string;
	/** Seconds the provider asked us to wait, when it said so. */
	readonly retryAfterSeconds?: number;
	readonly cause?: Error;
};

export class TemporaryAccountError extends Error {
	readonly code: TemporaryAccountErrorCode;
	readonly reason?: string;
	readonly retryAfterSeconds?: number;
	readonly retryable: boolean;

	constructor(
		code: TemporaryAccountErrorCode,
		message: string,
		options: TemporaryAccountErrorOptions = {},
	) {
		super(
			message,
			options.cause !== undefined ? { cause: options.cause } : undefined,
		);
		this.name = "TemporaryAccountError";
		this.code = code;
		this.retryable = RETRYABLE.has(code);
		if (options.reason !== undefined) this.reason = options.reason;
		if (options.retryAfterSeconds !== undefined) {
			this.retryAfterSeconds = options.retryAfterSeconds;
		}
	}

	/** The only shape safe to place in a log line, event, or receipt. */
	toJSON() {
		return {
			name: this.name,
			code: this.code,
			...(this.reason !== undefined ? { reason: this.reason } : undefined),
			retryable: this.retryable,
		};
	}
}

export function isTemporaryAccountError(
	value: Error,
): value is TemporaryAccountError {
	return value instanceof TemporaryAccountError;
}

/**
 * Map an HTTP status from the Cloudflare provisioning API onto a stable code.
 *
 * 5xx and 408 are ambiguous rather than failed: the account may exist even
 * though we never saw the response, so the caller must observe before retrying.
 */
export function temporaryAccountErrorForStatus(
	status: number,
	options: { readonly stage: string; readonly retryAfterSeconds?: number } & {
		readonly mutating?: boolean;
	},
): TemporaryAccountError {
	const detail = `cloudflare ${options.stage} returned HTTP ${status}`;
	const retryAfter =
		options.retryAfterSeconds !== undefined
			? { retryAfterSeconds: options.retryAfterSeconds }
			: undefined;
	if (status === 429) {
		return new TemporaryAccountError(
			"PROVIDER_RATE_LIMITED",
			detail,
			retryAfter,
		);
	}
	if (status === 401 || status === 403) {
		return new TemporaryAccountError("PROVIDER_AUTH_FAILED", detail);
	}
	if (status === 408 || status === 409 || status >= 500) {
		return new TemporaryAccountError(
			options.mutating === true
				? "PROVIDER_OPERATION_AMBIGUOUS"
				: "PROVIDER_UNAVAILABLE",
			detail,
			retryAfter,
		);
	}
	return new TemporaryAccountError("PROVIDER_CONTRACT_CHANGED", detail, {
		reason: "UNEXPECTED_STATUS",
	});
}
