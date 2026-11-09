/**
 * Stable HoBo error codes for the Netlify anonymous-static claim strategy.
 *
 * The anonymous path is the one where redaction matters most. An unauthenticated
 * deploy hands back a claim URL that *is* the site: whoever opens it owns the
 * project. CLI output and API bodies are therefore treated as hostile text and
 * scrubbed before they can reach a message, a log line, or a receipt.
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
	"PROVIDER_TOOL_UNAVAILABLE",
	"PROVIDER_TOOL_VERSION_UNSUPPORTED",
	"CAPABILITY_NOT_SUPPORTED",
	"CLAIM_EXPIRED",
	"CLAIM_NOT_VERIFIED",
	"CLAIM_PARTIALLY_COMPLETED",
	"CLAIM_REPAIR_REQUIRED",
	"BINDING_ROTATION_REQUIRED",
	"BOOTSTRAP_AUTHORITY_REMAINS",
	"CLEANUP_FAILED",
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
	readonly label?: string;
	readonly hits?: number;
	readonly preview?: string;
	readonly siteId?: string;
	readonly exitCode?: number;
	readonly stderr?: string;
	readonly haveId?: boolean;
	readonly haveAccount?: boolean;
	readonly adoptable?: boolean;
	readonly claimDeadlineMs?: number;
	readonly expirySource?: string;
	readonly bundleId?: string;
	readonly bundleStatus?: string;
};

export type ProviderErrorOptions = {
	/** Safe to repeat the operation verbatim. Ambiguity is never retryable. */
	readonly retryable?: boolean;
	readonly retryAfterMs?: number;
	readonly detail?: ProviderErrorDetail;
	readonly cause?: Error;
};

/** The provider's own patterns, on top of the shared ones. */
export const NETLIFY_REDACTION_PROFILE: ProviderRedactionProfile = {
	patterns: [
		// The claim URL carries its session material in the fragment, so the
		// fragment has to go with it — and the whole run it sits in. The match
		// starts only where a run without whitespace or quotes starts, so
		// `http://http://…` is one search, not one from every `http` to the end.
		/(?<![^\s"'])[^\s"']*app\.netlify\.com\/claim\S*/giu,
		// nfp_… is Netlify's personal access token prefix; nf_ covers session ids.
		/\bnf(?:p)?_[A-Za-z0-9]{8,}/giu,
	],
	collapseWhitespace: true,
};

const providerRedactor = createProviderRedactor(NETLIFY_REDACTION_PROFILE);

/**
 * Replace anything credential-shaped with a marker and flatten control
 * characters, which CLI output has plenty of and which can otherwise forge a
 * log record. The shared redactor (`@hobo/provider-redaction`) holds the
 * shapes, the window and the cut; Netlify adds its own below.
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
	const label = redactOptionalText(detail.label);
	const preview = redactOptionalText(detail.preview);
	const siteId = redactOptionalText(detail.siteId);
	const stderr = redactOptionalText(detail.stderr);
	const expirySource = redactOptionalText(detail.expirySource);
	const bundleId = redactOptionalText(detail.bundleId);
	const bundleStatus = redactOptionalText(detail.bundleStatus);
	return {
		...(detail.status !== undefined ? { status: detail.status } : undefined),
		...(method !== undefined ? { method } : undefined),
		...(operation !== undefined ? { operation } : undefined),
		...(body !== undefined ? { body } : undefined),
		...(guard !== undefined ? { guard } : undefined),
		...(purpose !== undefined ? { purpose } : undefined),
		...(resourceRef !== undefined ? { resourceRef } : undefined),
		...(label !== undefined ? { label } : undefined),
		...(detail.hits !== undefined ? { hits: detail.hits } : undefined),
		...(preview !== undefined ? { preview } : undefined),
		...(siteId !== undefined ? { siteId } : undefined),
		...(detail.exitCode !== undefined
			? { exitCode: detail.exitCode }
			: undefined),
		...(stderr !== undefined ? { stderr } : undefined),
		...(detail.haveId !== undefined ? { haveId: detail.haveId } : undefined),
		...(detail.haveAccount !== undefined
			? { haveAccount: detail.haveAccount }
			: undefined),
		...(detail.adoptable !== undefined
			? { adoptable: detail.adoptable }
			: undefined),
		...(detail.claimDeadlineMs !== undefined
			? { claimDeadlineMs: detail.claimDeadlineMs }
			: undefined),
		...(expirySource !== undefined ? { expirySource } : undefined),
		...(bundleId !== undefined ? { bundleId } : undefined),
		...(bundleStatus !== undefined ? { bundleStatus } : undefined),
	};
}

export class NetlifyProviderError extends Error {
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
		this.name = "NetlifyProviderError";
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

export function isNetlifyProviderError(
	value: Error,
): value is NetlifyProviderError {
	return value instanceof NetlifyProviderError;
}

export type ProviderStatusContext = {
	readonly method: "GET" | "POST" | "PUT" | "DELETE";
	readonly operation: string;
	readonly body?: string;
	readonly retryAfterMs?: number;
};

/**
 * Map a Netlify API status onto a HoBo code.
 *
 * 401/403 is load-bearing rather than incidental on this path: after a claim,
 * losing access with the anonymous credential is the evidence that the
 * credential no longer controls the site.
 */
export function providerErrorForStatus(
	status: number,
	context: ProviderStatusContext,
): NetlifyProviderError {
	const body =
		context.body === undefined ? "" : redactProviderText(context.body, 180);
	const detail: ProviderErrorDetail = {
		status,
		method: context.method,
		operation: context.operation,
		...(body !== "" ? { body } : undefined),
	};
	if (status === 429) {
		return new NetlifyProviderError(
			"PROVIDER_RATE_LIMITED",
			`netlify api returned 429 for ${context.operation}`,
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
		return new NetlifyProviderError(
			"PROVIDER_AUTH_FAILED",
			`netlify api returned ${status} for ${context.operation}`,
			{ detail },
		);
	}
	if (status === 404) {
		// An unclaimed anonymous project is removed one hour after the deploy,
		// so a missing site is an expiry rather than a generic not-found.
		return new NetlifyProviderError(
			"CLAIM_EXPIRED",
			`netlify api returned 404 for ${context.operation}; an unclaimed anonymous project is removed one hour after it is deployed`,
			{ detail },
		);
	}
	if (status >= 500) {
		return context.method === "GET"
			? new NetlifyProviderError(
					"PROVIDER_CONTRACT_CHANGED",
					`netlify api returned ${status} for ${context.operation}`,
					{ retryable: true, detail },
				)
			: new NetlifyProviderError(
					"PROVIDER_OPERATION_AMBIGUOUS",
					`netlify api returned ${status} to ${context.operation}; the mutation may or may not have applied`,
					{ detail },
				);
	}
	return new NetlifyProviderError(
		"PROVIDER_CONTRACT_CHANGED",
		`netlify api returned an unexpected ${status} for ${context.operation}`,
		{ detail },
	);
}
