/**
 * Stable error codes for the auth.md agent-principal plane.
 *
 * Codes are part of the package's public contract: callers branch on
 * `error.code`, never on message text. Details are string-only and pass
 * through the redacting formatter, so no assertion, claim token, private key,
 * or access token can ride out inside an error.
 */
import { redactText } from "./redaction.js";

export const AUTHMD_ERROR_CODES = [
	"AUTHMD_DISCOVERY_FAILED",
	"AUTHMD_METADATA_INVALID",
	"AUTHMD_REGISTRATION_UNSUPPORTED",
	"AUTHMD_ASSERTION_INVALID",
	"AUTHMD_CLAIM_EXPIRED",
	"AUTHMD_SCOPE_WIDENING_DENIED",
	"AUTHMD_ROTATION_REQUIRED",
	"AUTHMD_REVOKED",
] as const;

export type AuthMdErrorCode = (typeof AUTHMD_ERROR_CODES)[number];

export function isAuthMdErrorCode(value: unknown): value is AuthMdErrorCode {
	return (
		typeof value === "string" &&
		(AUTHMD_ERROR_CODES as readonly string[]).includes(value)
	);
}

export interface AuthMdErrorJson {
	readonly name: "AuthMdError";
	readonly code: AuthMdErrorCode;
	readonly message: string;
	readonly details: Readonly<Record<string, string>>;
}

export class AuthMdError extends Error {
	readonly code: AuthMdErrorCode;
	readonly details: Readonly<Record<string, string>>;

	constructor(
		code: AuthMdErrorCode,
		message: string,
		details: Readonly<Record<string, string>> = {},
	) {
		super(redactText(message));
		this.name = "AuthMdError";
		this.code = code;
		this.details = Object.freeze(
			Object.fromEntries(
				Object.entries(details).map(([key, value]) => [key, redactText(value)]),
			),
		);
	}

	toJSON(): AuthMdErrorJson {
		return {
			name: "AuthMdError",
			code: this.code,
			message: this.message,
			details: this.details,
		};
	}
}

export function isAuthMdError(value: unknown): value is AuthMdError {
	return value instanceof AuthMdError;
}

export function authMdError(
	code: AuthMdErrorCode,
	message: string,
	details?: Readonly<Record<string, string>>,
): AuthMdError {
	return new AuthMdError(code, message, details);
}
