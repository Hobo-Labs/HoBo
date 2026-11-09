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

import {
	createProviderRedactor,
	type ProviderTextRedactor,
} from "@hobo/core/provider-redaction";

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

/**
 * Redact credential-shaped substrings and flatten control characters, through
 * the shared redactor (`@hobo/core/provider-redaction`), which holds every
 * shape this needs (`requirepass` included), the window and the cut.
 *
 * A container runtime echoes back the command line it was handed, so text from
 * a pack operation is exactly the text most likely to carry a credential.
 */
export const redactPackText: ProviderTextRedactor = createProviderRedactor();

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

// Preserve the caught value's type while narrowing it to PackError.
export function isPackError<T>(value: T): value is T & PackError {
	return value instanceof PackError;
}
