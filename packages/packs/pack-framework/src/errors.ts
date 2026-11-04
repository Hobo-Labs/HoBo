/**
 * Stable error codes for pack mechanics.
 *
 * `ARCHITECTURE_UNSUPPORTED` and `PROVIDER_CONTRACT_CHANGED` are deliberately
 * spelled exactly as the selection layer spells them
 * (`@hobo/capability-profiles` rejection codes / the provider error family), so
 * a pack failure and a managed-provider failure are the same fact to a caller.
 * `PACK_INTEGRITY_UNVERIFIED` is the pack-specific integrity code: it covers a
 * moving tag, a missing signature, an untrusted key, and a payload that does
 * not match what was signed.
 */

export const PACK_ERROR_CODES = [
	"PACK_MANIFEST_INVALID",
	"PACK_INTEGRITY_UNVERIFIED",
	"ARCHITECTURE_UNSUPPORTED",
	"PROVIDER_CONTRACT_CHANGED",
	"PACK_PERSISTENCE_REQUIRED",
	"PACK_CONFIGURATION_INVALID",
	"PACK_CONFORMANCE_FAILED",
	"PACK_OPERATION_FAILED",
	"SECRET_CUSTODY_UNAVAILABLE",
] as const;

export type PackErrorCode = (typeof PACK_ERROR_CODES)[number];

export type PackErrorDetail = Readonly<
	Record<string, string | number | boolean>
>;

export type PackErrorOptions = {
	readonly detail?: PackErrorDetail;
	// `unknown`, matching the platform: this is handed straight to `Error`'s own
	// `cause` and never serialized -- `toJSON` deliberately omits it, since a
	// cause carries whatever was thrown and this projection is receipt-safe. The
	// callers are `catch` bindings, which are `unknown` by definition.
	readonly cause?: unknown;
};

export interface PackErrorJson {
	readonly name: string;
	readonly code: PackErrorCode;
	readonly message: string;
	readonly detail: PackErrorDetail;
}

/** Shapes that must never survive into a message, a log line, or a receipt. */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
	/postgres(?:ql)?:\/\/\S+/giu,
	/rediss?:\/\/\S+/giu,
	/\bBearer\s+\S+/giu,
	/\b(?:password|pgpassword|requirepass|pwd)\s*[=:]\s*\S+/giu,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/giu,
];

function stripControlChars(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		out += code <= 0x1f || code === 0x7f ? " " : text[i];
	}
	return out;
}

/**
 * Redact credential-shaped substrings and flatten control characters.
 *
 * A container runtime echoes back the command line it was handed, so text from
 * a pack operation is exactly the text most likely to carry a credential.
 */
export function redactPackText(text: string, maxLength = 256): string {
	let out = text;
	for (const pattern of CREDENTIAL_PATTERNS)
		out = out.replace(pattern, "[redacted]");
	out = stripControlChars(out).trim();
	return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}

export class PackError extends Error {
	readonly code: PackErrorCode;
	readonly detail: PackErrorDetail;

	constructor(
		code: PackErrorCode,
		message: string,
		options: PackErrorOptions = {},
	) {
		super(
			redactPackText(message),
			options.cause !== undefined ? { cause: options.cause } : {},
		);
		this.name = "PackError";
		this.code = code;
		this.detail = Object.freeze({ ...options.detail });
	}

	/** Receipt-safe projection; already redacted by construction. */
	toJSON(): PackErrorJson {
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			detail: this.detail,
		};
	}
}

// `unknown`, not `JsonValue`: a `PackError` is not JSON, so a predicate
// narrowing between them has no overlap and cannot type-check. Testing a caught
// value is the whole use.
export function isPackError(value: unknown): value is PackError {
	return value instanceof PackError;
}
