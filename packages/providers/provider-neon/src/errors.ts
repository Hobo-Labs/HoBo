/**
 * Stable HoBo error codes for the Neon claimable-Postgres driver.
 *
 * Provider text is never interpolated verbatim: an upstream error body has
 * carried a connection string before, and an error message is the one string
 * that reliably reaches a log, a receipt, and a support ticket.
 */

import {
	createProviderRedactor,
	type ProviderRedactionProfile,
} from "@hobo/core/provider-redaction";
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
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export type ProviderErrorDetail = Readonly<
	Record<string, string | number | boolean>
>;

export type ProviderErrorOptions = {
	/** Safe to repeat the operation verbatim. Ambiguity is never retryable. */
	readonly retryable?: boolean;
	readonly retryAfterMs?: number;
	readonly detail?: ProviderErrorDetail;
	readonly cause?: Error;
};

export { containsControlChar } from "@hobo/core/provider-redaction";

/** The provider's own patterns, on top of the shared ones. */
export const NEON_REDACTION_PROFILE: ProviderRedactionProfile = {
	patterns: [
		/https?:\/\/neon\.new\/claim\/\S+/giu,
		/\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/giu,
		/\bnpg_[A-Za-z0-9_-]{4,}/giu,
	],
	decodePercent: true,
};

const providerRedactor = createProviderRedactor(NEON_REDACTION_PROFILE);

/**
 * Replace anything credential-shaped with a marker and flatten control
 * characters so provider text cannot forge a log record. The text is
 * percent-decoded fully first, so an encoded credential is found too. The
 * shared redactor (`@hobo/core/provider-redaction`) holds the shapes, the
 * window and the cut; Neon adds its claim URL, project UUIDs and `npg_`
 * passwords.
 */
export function redactProviderText(text: string, maxLength = 256): string {
	return providerRedactor(text, maxLength);
}

export class NeonProviderError extends Error {
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
		this.name = "NeonProviderError";
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

export function isProviderError(value: Error): value is NeonProviderError {
	return value instanceof NeonProviderError;
}

/** Map an HTTP status from the claimable-database API onto a HoBo code. */
export function providerErrorForStatus(
	status: number,
	options: {
		readonly method: "GET" | "POST";
		readonly body?: string;
		readonly retryAfterMs?: number;
	},
): NeonProviderError {
	const body =
		options.body === undefined ? "" : redactProviderText(options.body, 180);
	const detail = {
		status,
		method: options.method,
		...(body ? { body } : undefined),
	};
	if (status === 429) {
		return new NeonProviderError(
			"PROVIDER_RATE_LIMITED",
			`neon.new returned 429`,
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
		return new NeonProviderError(
			"PROVIDER_AUTH_FAILED",
			`neon.new returned ${status}`,
			{ detail },
		);
	}
	if (status === 409) {
		return new NeonProviderError(
			"PROVISIONING_CONFLICT",
			`neon.new returned 409`,
			{ detail },
		);
	}
	if (status >= 500) {
		// A 5xx on a create is indistinguishable from "created but not
		// acknowledged", so it is ambiguous rather than retryable. A 5xx on a
		// read is safe to repeat.
		return options.method === "POST"
			? new NeonProviderError(
					"PROVIDER_OPERATION_AMBIGUOUS",
					`neon.new returned ${status} to a create; the database may or may not exist`,
					{ detail },
				)
			: new NeonProviderError(
					"PROVIDER_CONTRACT_CHANGED",
					`neon.new returned ${status}`,
					{
						retryable: true,
						detail,
					},
				);
	}
	return new NeonProviderError(
		"PROVIDER_CONTRACT_CHANGED",
		`neon.new returned an unexpected ${status}`,
		{ detail },
	);
}
