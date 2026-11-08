/**
 * Stable HoBo error codes for the Upstash temporary-Redis driver.
 *
 * The redaction here is not decoration. The provider's create response is a
 * markdown document with a bearer token in it, and the two places a whole
 * response body most often ends up are a parse error and a log line. So every
 * message and every detail value goes through {@link redactProviderText}
 * before it can be constructed, not after someone remembers to call it.
 */

/**
 * Two codes here are additions to the platform's baseline set, and both are
 * recorded in the README so the coordinator can promote or rename them:
 *
 * - `CLAIM_NOT_VERIFIED` — ownership could not be *proved*, which is different
 *   from a claim window having expired. Collapsing it into `CLAIM_EXPIRED`
 *   would tell an operator to re-run a ceremony that may already have worked.
 * - `SECRET_CUSTODY_UNAVAILABLE` — the deposit side failed. Reporting that as
 *   `SECRET_REFERENCE_INVALID` would blame a reference that was never issued.
 */
export const PROVIDER_ERROR_CODES = [
	"PROVIDER_AUTH_FAILED",
	"PROVIDER_RATE_LIMITED",
	"PROVIDER_CONTRACT_CHANGED",
	"PROVIDER_OPERATION_AMBIGUOUS",
	"LEASE_EXPIRED",
	"CLAIM_EXPIRED",
	"CLAIM_NOT_VERIFIED",
	"SECRET_REFERENCE_INVALID",
	"SECRET_CUSTODY_UNAVAILABLE",
	"CLEANUP_FAILED",
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export type ProviderErrorDetail = {
	readonly status?: number;
	readonly method?: string;
	readonly body?: string;
	readonly guard?: string;
	readonly idempotencyKey?: string;
	readonly returnedId?: string;
	readonly databaseId?: string;
	readonly expected?: string;
	readonly observed?: string;
	readonly verb?: string;
	readonly preview?: string;
	readonly length?: number;
	readonly bindingId?: string;
	readonly purpose?: string;
	readonly resourceRef?: string;
	readonly expiresAtIso?: string;
	readonly expiresAtMs?: number;
	readonly claimState?: string;
	readonly claimUrl?: string;
	readonly location?: string;
};

export type ProviderErrorOptions = {
	/** Safe to repeat the operation verbatim. Ambiguity is never retryable. */
	readonly retryable?: boolean;
	readonly retryAfterMs?: number;
	readonly detail?: ProviderErrorDetail;
	readonly cause?: Error;
};

/**
 * Shapes that must never survive into a message, a log line, or a receipt.
 *
 * The generic opaque-blob rule is the important one: Upstash REST tokens are
 * long base64url strings with no fixed prefix to match on, so the rule is
 * structural — any unbroken run of 40+ token characters is treated as
 * credential material. Native UUIDs are also bearer capabilities and are
 * removed independently, including percent-encoded forms.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
	/https?:\/\/console\.upstash\.com\/redis\/\S+/giu,
	/\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/giu,
	/\*\*\s*Token\s*:?\s*\*\*\s*\S+/giu,
	/\bBearer\s+\S+/giu,
	/\bUPSTASH_REDIS_REST_TOKEN\s*[=:]\s*\S+/giu,
	/\b(?:token|password|pwd)\s*[=:]\s*\S+/giu,
	/\brediss?:\/\/\S+/giu,
	/[A-Za-z0-9_-]{40,}/gu,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/giu,
];

function flattenControlChars(text: string): string {
	let out = "";
	for (const ch of text) {
		const code = ch.charCodeAt(0);
		out += code <= 31 || code === 127 ? " " : ch;
	}
	return out;
}

export function containsControlChar(text: string): boolean {
	for (const ch of text) {
		const code = ch.charCodeAt(0);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

/**
 * Replace anything credential-shaped with a marker and flatten control
 * characters so provider text cannot forge a log record.
 */
export function redactProviderText(text: string, maxLength = 256): string {
	let out = text;
	for (;;) {
		const decoded = out.replace(/%[a-f0-9]{2}/giu, (encoded) =>
			String.fromCharCode(Number.parseInt(encoded.slice(1), 16)),
		);
		if (decoded === out) break;
		out = decoded;
	}
	for (const pattern of CREDENTIAL_PATTERNS)
		out = out.replace(pattern, "[redacted]");
	out = flattenControlChars(out)
		.replace(/\s{2,}/gu, " ")
		.trim();
	return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}

function redactOptionalText(value: string | undefined): string | undefined {
	return value === undefined ? undefined : redactProviderText(value, 160);
}

function redactDetail(detail: ProviderErrorDetail): ProviderErrorDetail {
	const method = redactOptionalText(detail.method);
	const body = redactOptionalText(detail.body);
	const guard = redactOptionalText(detail.guard);
	const idempotencyKey = redactOptionalText(detail.idempotencyKey);
	const returnedId = redactOptionalText(detail.returnedId);
	const databaseId = redactOptionalText(detail.databaseId);
	const expected = redactOptionalText(detail.expected);
	const observed = redactOptionalText(detail.observed);
	const verb = redactOptionalText(detail.verb);
	const preview = redactOptionalText(detail.preview);
	const bindingId = redactOptionalText(detail.bindingId);
	const purpose = redactOptionalText(detail.purpose);
	const resourceRef = redactOptionalText(detail.resourceRef);
	const expiresAtIso = redactOptionalText(detail.expiresAtIso);
	const claimState = redactOptionalText(detail.claimState);
	const claimUrl = redactOptionalText(detail.claimUrl);
	const location = redactOptionalText(detail.location);
	return {
		...(detail.status !== undefined ? { status: detail.status } : undefined),
		...(method !== undefined ? { method } : undefined),
		...(body !== undefined ? { body } : undefined),
		...(guard !== undefined ? { guard } : undefined),
		...(idempotencyKey !== undefined ? { idempotencyKey } : undefined),
		...(returnedId !== undefined ? { returnedId } : undefined),
		...(databaseId !== undefined ? { databaseId } : undefined),
		...(expected !== undefined ? { expected } : undefined),
		...(observed !== undefined ? { observed } : undefined),
		...(verb !== undefined ? { verb } : undefined),
		...(preview !== undefined ? { preview } : undefined),
		...(detail.length !== undefined ? { length: detail.length } : undefined),
		...(bindingId !== undefined ? { bindingId } : undefined),
		...(purpose !== undefined ? { purpose } : undefined),
		...(resourceRef !== undefined ? { resourceRef } : undefined),
		...(expiresAtIso !== undefined ? { expiresAtIso } : undefined),
		...(detail.expiresAtMs !== undefined
			? { expiresAtMs: detail.expiresAtMs }
			: undefined),
		...(claimState !== undefined ? { claimState } : undefined),
		...(claimUrl !== undefined ? { claimUrl } : undefined),
		...(location !== undefined ? { location } : undefined),
	};
}

export class UpstashProviderError extends Error {
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
		this.name = "UpstashProviderError";
		this.code = code;
		this.retryable = options.retryable ?? false;
		if (options.retryAfterMs !== undefined)
			this.retryAfterMs = options.retryAfterMs;
		this.detail = redactDetail(options.detail ?? {});
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

export function isProviderError(value: Error): value is UpstashProviderError {
	return value instanceof UpstashProviderError;
}

/**
 * Map an HTTP status onto a HoBo code.
 *
 * The interesting case is 5xx on a create. `POST /start-redis` is idempotent
 * on the `Idempotency-Key`, so an unacknowledged create is recoverable — but
 * it is still not *known* to have failed, and calling it retryable would let a
 * caller treat "unknown" as "safe to redo blindly". It is reported as
 * ambiguous, and the client resolves it by re-POSTing the same key, which
 * adopts rather than duplicates.
 */
export function providerErrorForStatus(
	status: number,
	options: {
		readonly method: "GET" | "POST";
		readonly body?: string;
		readonly retryAfterMs?: number;
	},
): UpstashProviderError {
	const body =
		options.body === undefined ? "" : redactProviderText(options.body, 160);
	const detail = {
		status,
		method: options.method,
		...(body !== "" ? { body } : undefined),
	};
	if (status === 429) {
		return new UpstashProviderError(
			"PROVIDER_RATE_LIMITED",
			"upstash.com returned 429",
			{
				retryable: true,
				...(options.retryAfterMs !== undefined
					? { retryAfterMs: options.retryAfterMs }
					: undefined),
				detail,
			},
		);
	}
	if (status === 401 || status === 403) {
		return new UpstashProviderError(
			"PROVIDER_AUTH_FAILED",
			`upstash.com returned ${status}; the no-signup surface should never require authorization, so this is either a contract change or a credential being sent that should not be`,
			{ detail },
		);
	}
	if (status >= 500) {
		return options.method === "POST"
			? new UpstashProviderError(
					"PROVIDER_OPERATION_AMBIGUOUS",
					`upstash.com returned ${status} to a create; the database may or may not exist, so the same idempotency key must be reused`,
					{ detail },
				)
			: new UpstashProviderError(
					"PROVIDER_CONTRACT_CHANGED",
					`upstash.com returned ${status}`,
					{
						retryable: true,
						detail,
					},
				);
	}
	return new UpstashProviderError(
		"PROVIDER_CONTRACT_CHANGED",
		`upstash.com returned an unexpected ${status}`,
		{ detail },
	);
}
