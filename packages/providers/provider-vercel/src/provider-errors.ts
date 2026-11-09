/**
 * Stable HoBo error codes for the Vercel sponsored-project-transfer driver.
 *
 * Provider text is never interpolated verbatim. A Vercel API error body can
 * echo a request payload, and a payload on this path carries a transfer code or
 * a marketplace resource secret — and an error message is the one string that
 * reliably reaches a log, a receipt, and a support ticket.
 */

import {
	createProviderRedactor,
	type ProviderRedactionProfile,
} from "@hobo/provider-redaction";

export const PROVIDER_ERROR_CODES = [
	"PROVIDER_RATE_LIMITED",
	"PROVIDER_AUTH_FAILED",
	"PROVIDER_CONTRACT_CHANGED",
	"PROVIDER_OPERATION_AMBIGUOUS",
	"CLAIM_EXPIRED",
	"CLAIM_NOT_VERIFIED",
	"CLAIM_PARTIALLY_COMPLETED",
	"CLAIM_REPAIR_REQUIRED",
	"BINDING_ROTATION_REQUIRED",
	"BOOTSTRAP_AUTHORITY_REMAINS",
	"CLEANUP_FAILED",
	"SPONSOR_BUDGET_EXCEEDED",
	"SECRET_CUSTODY_UNAVAILABLE",
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export type ProviderErrorDetail = {
	readonly status?: number;
	readonly method?: string;
	readonly operation?: string;
	readonly body?: string;
	readonly guard?: string;
	readonly purpose?: string;
	readonly resourceRef?: string;
	readonly preview?: string;
	readonly field?: string;
	readonly itemId?: string;
	readonly exposureMinorUnits?: number;
	readonly remainingBudgetMinorUnits?: number;
};

export type ProviderErrorOptions = {
	/** Safe to repeat the operation verbatim. Ambiguity is never retryable. */
	readonly retryable?: boolean;
	readonly retryAfterMs?: number;
	readonly detail?: ProviderErrorDetail;
	readonly cause?: Error;
};

export { REDACTION_WINDOW } from "@hobo/provider-redaction";

/** The provider's own patterns, on top of the shared ones. */
export const VERCEL_REDACTION_PROFILE: ProviderRedactionProfile = {
	// A claim or transfer code, and the rest of its run: what is glued to a
	// code (`code=abc12345=…`) is not told apart from it.
	patterns: [/\bcode\s*[=:]\s*[A-Za-z0-9-]{8,}\S*/giu],
};

const providerRedactor = createProviderRedactor(VERCEL_REDACTION_PROFILE);

/**
 * Replace anything credential-shaped with a marker and flatten control
 * characters so provider text cannot forge a log record. The shared redactor
 * (`@hobo/provider-redaction`) holds the shapes, the window and the cut;
 * Vercel adds its claim and transfer codes, which are bearer authority on this
 * path.
 */
export function redactProviderText(text: string, maxLength = 256): string {
	return providerRedactor(text, maxLength);
}

function redactOptionalText(value: string | undefined): string | undefined {
	return value === undefined ? undefined : redactProviderText(value, 160);
}

function redactDetail(detail: ProviderErrorDetail): ProviderErrorDetail {
	const method = redactOptionalText(detail.method);
	const operation = redactOptionalText(detail.operation);
	const body = redactOptionalText(detail.body);
	const guard = redactOptionalText(detail.guard);
	const purpose = redactOptionalText(detail.purpose);
	const resourceRef = redactOptionalText(detail.resourceRef);
	const preview = redactOptionalText(detail.preview);
	const field = redactOptionalText(detail.field);
	const itemId = redactOptionalText(detail.itemId);
	return {
		...(detail.status !== undefined ? { status: detail.status } : undefined),
		...(method !== undefined ? { method } : undefined),
		...(operation !== undefined ? { operation } : undefined),
		...(body !== undefined ? { body } : undefined),
		...(guard !== undefined ? { guard } : undefined),
		...(purpose !== undefined ? { purpose } : undefined),
		...(resourceRef !== undefined ? { resourceRef } : undefined),
		...(preview !== undefined ? { preview } : undefined),
		...(field !== undefined ? { field } : undefined),
		...(itemId !== undefined ? { itemId } : undefined),
		...(detail.exposureMinorUnits !== undefined
			? { exposureMinorUnits: detail.exposureMinorUnits }
			: undefined),
		...(detail.remainingBudgetMinorUnits !== undefined
			? { remainingBudgetMinorUnits: detail.remainingBudgetMinorUnits }
			: undefined),
	};
}

export class VercelProviderError extends Error {
	readonly code: ProviderErrorCode;
	readonly retryable: boolean;
	readonly retryAfterMs?: number;
	readonly detail: ProviderErrorDetail;

	constructor(
		code: ProviderErrorCode,
		message: string,
		options: ProviderErrorOptions = {},
	) {
		super(
			redactProviderText(message),
			options.cause !== undefined ? { cause: options.cause } : undefined,
		);
		this.name = "VercelProviderError";
		this.code = code;
		this.retryable = options.retryable ?? false;
		if (options.retryAfterMs !== undefined)
			this.retryAfterMs = options.retryAfterMs;
		this.detail = Object.freeze(redactDetail(options.detail ?? {}));
	}

	/** Receipt-safe projection. Already redacted by construction. */
	toJSON() {
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			retryable: this.retryable,
			...(this.retryAfterMs !== undefined
				? { retryAfterMs: this.retryAfterMs }
				: undefined),
			detail: this.detail,
		};
	}
}

export function isVercelProviderError(
	value: Error,
): value is VercelProviderError {
	return value instanceof VercelProviderError;
}

export type ProviderStatusContext = {
	readonly method: "GET" | "POST" | "PUT" | "DELETE";
	readonly operation: string;
	readonly body?: string;
	readonly retryAfterMs?: number;
};

/**
 * Map a Vercel REST status onto a HoBo code.
 *
 * A 410 is specifically called out by the transfer-request endpoint, and it is
 * the expiry of a 24-hour code rather than a generic gone.
 */
export function providerErrorForStatus(
	status: number,
	context: ProviderStatusContext,
): VercelProviderError {
	const body =
		context.body === undefined ? "" : redactProviderText(context.body, 180);
	const detail: ProviderErrorDetail = {
		status,
		method: context.method,
		operation: context.operation,
		...(body !== "" ? { body } : undefined),
	};
	if (status === 429) {
		return new VercelProviderError(
			"PROVIDER_RATE_LIMITED",
			`vercel api returned 429 for ${context.operation}`,
			{
				retryable: true,
				...(context.retryAfterMs !== undefined
					? { retryAfterMs: context.retryAfterMs }
					: undefined),
				detail,
			},
		);
	}
	if (status === 401 || status === 403) {
		return new VercelProviderError(
			"PROVIDER_AUTH_FAILED",
			`vercel api returned ${status} for ${context.operation}`,
			{ detail },
		);
	}
	if (status === 410) {
		return new VercelProviderError(
			"CLAIM_EXPIRED",
			`vercel api returned 410 for ${context.operation}; the transfer code is past its documented 24 hour window`,
			{ detail },
		);
	}
	if (status >= 500) {
		// A 5xx on a mutation is indistinguishable from "applied but not
		// acknowledged", so it is ambiguous rather than retryable. A 5xx on a
		// read is safe to repeat.
		return context.method === "GET"
			? new VercelProviderError(
					"PROVIDER_CONTRACT_CHANGED",
					`vercel api returned ${status} for ${context.operation}`,
					{ retryable: true, detail },
				)
			: new VercelProviderError(
					"PROVIDER_OPERATION_AMBIGUOUS",
					`vercel api returned ${status} to ${context.operation}; the mutation may or may not have applied`,
					{ detail },
				);
	}
	return new VercelProviderError(
		"PROVIDER_CONTRACT_CHANGED",
		`vercel api returned an unexpected ${status} for ${context.operation}`,
		{ detail },
	);
}
