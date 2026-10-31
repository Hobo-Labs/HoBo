/**
 * Stable HoBo error codes for the Vercel sponsored-project-transfer driver.
 *
 * Provider text is never interpolated verbatim. A Vercel API error body can
 * echo a request payload, and a payload on this path carries a transfer code or
 * a marketplace resource secret — and an error message is the one string that
 * reliably reaches a log, a receipt, and a support ticket.
 */

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

/**
 * How much of a text the shapes below are searched in: its first
 * REDACTION_WINDOW characters, or four times `maxLength` when that is more. An
 * error message is cut far shorter than this, so a longer text only costs time:
 * a hostile body of a megabyte is searched no further than this.
 */
export const REDACTION_WINDOW = 8192;

/**
 * Shapes that must never survive into an error message, log line, or receipt.
 * Each is linear in the text: none can start again inside a run it has already
 * scanned to its end.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
	// Prisma Postgres hands out prisma+postgres://…?api_key=… as well as a
	// direct postgres:// string, so both shapes are stripped.
	/prisma\+postgres:\/\/\S+/giu,
	/postgres(?:ql)?:\/\/\S+/giu,
	/\bapi[_-]?key\s*[=:]\s*\S+/giu,
	/\bBearer\s+\S+/giu,
	/\b(?:password|pgpassword|pwd)\s*[=:]\s*\S+/giu,
	// Vercel claim/transfer codes are bearer authority on this path.
	/\bcode\s*[=:]\s*[A-Za-z0-9-]{8,}/giu,
	/\b(?:sk|pk)[-_][A-Za-z0-9_-]{8,}/giu,
	// A JWT starts only where a run of base64url characters starts, so
	// `-ey-ey-ey…` is one search, not one from every `ey` to the end.
	/(?<![A-Za-z0-9_-])ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.\S*/giu,
	// A private key, from its BEGIN line to its END line, or to the next BEGIN or
	// END line of any kind, or to the end of the text when there is none (as
	// when the text was cut inside the key): never a search from every BEGIN to
	// the end.
	/-----BEGIN [A-Z ]*PRIVATE KEY-----(?:(?!-----(?:BEGIN|END) )[\s\S])*(?:-----END [A-Z ]*PRIVATE KEY-----)?/giu,
];

/**
 * `text` cut at `window` characters. A cut inside a run of non-whitespace drops
 * that whole run: every shape above but the private key ends at whitespace, so
 * a credential the cut runs through leaves nothing behind. A private key cut
 * after its BEGIN line is redacted to the end of the window.
 */
function windowOf(text: string, window: number): string {
	if (text.length <= window) return text;
	const whitespace = /\s/u;
	let end = window;
	if (!whitespace.test(text.charAt(window))) {
		while (end > 0 && !whitespace.test(text.charAt(end - 1))) end--;
	}
	return text.slice(0, end);
}

function flattenControlChars(text: string): string {
	let out = "";
	for (const ch of text) {
		const code = ch.charCodeAt(0);
		out += code <= 31 || code === 127 ? " " : ch;
	}
	return out;
}

/**
 * Replace anything credential-shaped with a marker and flatten control
 * characters so provider text cannot forge a log record. Only the window
 * (REDACTION_WINDOW) is searched and kept; a text longer than it is marked cut.
 */
export function redactProviderText(text: string, maxLength = 256): string {
	const window = Math.max(REDACTION_WINDOW, 4 * maxLength);
	let out = windowOf(text, window);
	for (const pattern of CREDENTIAL_PATTERNS)
		out = out.replace(pattern, "[redacted]");
	out = flattenControlChars(out).trim();
	return out.length > maxLength || text.length > window
		? `${out.slice(0, maxLength)}…`
		: out;
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
