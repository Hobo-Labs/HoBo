/**
 * Stable HoBo error codes for the Prisma Postgres claimable driver.
 *
 * The provider surface here is a CLI, so "provider text" means child-process
 * stdout and stderr — which, for a tool whose whole job is printing a
 * connection string, is the most credential-dense text in the system. Nothing
 * from it reaches a message without going through {@link redactProviderText}.
 */
import { isJsonString } from "./json.js";

export const PROVIDER_ERROR_CODES = [
	"PROVIDER_RATE_LIMITED",
	"PROVIDER_AUTH_FAILED",
	"PROVIDER_CONTRACT_CHANGED",
	"PROVIDER_OPERATION_AMBIGUOUS",
	"PROVISIONING_CONFLICT",
	"LEASE_EXPIRED",
	"CLAIM_EXPIRED",
	"CLAIM_NOT_VERIFIED",
	"BINDING_ROTATION_REQUIRED",
	"MIGRATION_FAILED",
	"SECRET_CUSTODY_UNAVAILABLE",
	"SECRET_REFERENCE_INVALID",
	"CLEANUP_FAILED",
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export type ProviderErrorDetail = Readonly<
	Record<string, string | number | boolean>
>;

export type ProviderErrorOptions = {
	readonly retryable?: boolean;
	readonly retryAfterMs?: number;
	readonly detail?: ProviderErrorDetail;
	readonly cause?: Error;
};

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
	/https?:\/\/create-db\.prisma\.io\/claim\S*/giu,
	/\bproj_[A-Za-z0-9_-]+/gu,
	/\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/giu,
	/postgres(?:ql)?:\/\/\S+/giu,
	/prisma\+postgres:\/\/\S+/giu,
	/\bBearer\s+\S+/giu,
	/\b(?:password|pgpassword|pwd)\s*[=:]\s*\S+/giu,
	/\bapi_key=\S+/giu,
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
	out = flattenControlChars(out).trim();
	return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}

export class PrismaProviderError extends Error {
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
		this.name = "PrismaProviderError";
		this.code = code;
		this.retryable = options.retryable ?? false;
		if (options.retryAfterMs !== undefined)
			this.retryAfterMs = options.retryAfterMs;
		this.detail = Object.freeze(
			Object.fromEntries(
				Object.entries(options.detail ?? {}).map(([key, value]) => [
					key,
					/idempotency|database.?id|project.?id|claim.?url/iu.test(key)
						? "[redacted]"
						: isJsonString(value)
							? redactProviderText(value)
							: value,
				]),
			),
		);
	}

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

export function isProviderError(value: Error): value is PrismaProviderError {
	return value instanceof PrismaProviderError;
}
