/**
 * Stable HoBo error codes for the ttl.sh ephemeral artifact transport.
 *
 * Two of these codes carry most of the meaning of this package.
 *
 * `CREDENTIAL_REFUSED` is not a failure to authenticate — it is this package
 * refusing to *try*. ttl.sh documents no authentication, so a credential heading
 * towards it could only be an accident (an ambient Docker config, a proxy that
 * adds a header, a helper written for a private registry), and the consequence of
 * that accident is a secret mailed to an anonymous public service.
 *
 * `LEASE_EXPIRED` is the registry's only teardown. There is nothing to delete and
 * nothing to release; artifacts simply stop existing. A 404 is therefore the
 * expected end state rather than a failure to explain away, which is why it maps
 * here and is **not** retryable: the fix is a new push, and a retry loop against a
 * reaped artifact is a loop that ends at a timeout.
 *
 * Registry and tool text is never interpolated verbatim. Anyone can push a
 * repository name to ttl.sh, so its error bodies are attacker-influenced, and an
 * error message is the one string that reliably reaches a log, a receipt, and a
 * support ticket.
 */

import {
	createProviderRedactor,
	type ProviderRedactionProfile,
} from "@hobo/provider-redaction";

export const TTL_SH_ERROR_CODES = [
	/** A host, scheme, port, or path outside the single allowlisted origin. */
	"TRANSPORT_NOT_ALLOWED",
	/** Credential-shaped material heading for a registry that authenticates nobody. */
	"CREDENTIAL_REFUSED",
	/** A malformed reference, digest, or push instant. */
	"INVALID_IMAGE_REFERENCE",
	/** A name a stranger could try. On an anonymous registry the name is the lock. */
	"GUESSABLE_ARTIFACT_NAME",
	/** A TTL outside the documented minutes-to-24-hours window, or in a unit ttl.sh does not document. */
	"TTL_OUT_OF_RANGE",
	/** An argv this package will not spawn: unknown binary, unallowlisted flag, control character. */
	"UNSAFE_TOOL_INVOCATION",
	/** The push definitely did not land. */
	"ARTIFACT_PUSH_FAILED",
	/** A live reference already carries different content. */
	"REFERENCE_REUSED",
	/** The TTL has elapsed, so the registry has deleted the artifact. */
	"LEASE_EXPIRED",
	/** Asked to hold something this transport must not hold. */
	"ARTIFACT_DURABLE_USE_REFUSED",
	/** The promotion destination is not a registry anybody is responsible for. */
	"PROMOTION_TARGET_INVALID",
	"PROVIDER_RATE_LIMITED",
	"PROVIDER_UNAVAILABLE",
	/** The request did not complete, so the registry's state is unknown. */
	"PROVIDER_OPERATION_AMBIGUOUS",
	/** The registry answered in a way its documented contract does not describe. */
	"PROVIDER_CONTRACT_CHANGED",
] as const;

export type TtlShErrorCode = (typeof TTL_SH_ERROR_CODES)[number];

export type TtlShErrorDetail = {
	readonly status?: number;
	readonly method?: string;
	readonly body?: string;
	readonly header?: string;
	readonly guard?: string;
	readonly location?: string;
	readonly host?: string;
	readonly path?: string;
	readonly url?: string;
	readonly port?: string;
	readonly allowed?: string;
	readonly binary?: string;
	readonly flag?: string;
	readonly code?: number;
	readonly pullReference?: string;
	readonly reported?: string;
	readonly declared?: string;
	readonly agreed?: string;
	readonly requested?: string;
	readonly target?: string;
	readonly reference?: string;
	readonly stderr?: string;
	readonly expected?: string;
};

export type TtlShErrorOptions = {
	/** Safe to repeat the operation verbatim. Ambiguity is never retryable. */
	readonly retryable?: boolean;
	readonly retryAfterMs?: number;
	readonly detail?: TtlShErrorDetail;
	readonly cause?: Error;
};

export { containsControlChar } from "@hobo/provider-redaction";

/** The provider's own patterns, on top of the shared ones. */
export const TTL_SH_REDACTION_PROFILE: ProviderRedactionProfile = {
	keep: /\bsha(?:256|512)[:-][0-9a-f]{32,128}\b/gi,
	patterns: [/\bBasic\s+\S+/gi],
	// A long opaque run with no recognisable prefix, for credential formats
	// nobody has catalogued yet. Deliberately excludes `/` and `.`, so a URL
	// path is not mistaken for one long token. It starts only where such a run
	// starts, so one long run is one search. Searched last: run before the JWT
	// shape, it split a token and left the payload behind.
	fallbacks: [/(?<![A-Za-z0-9+_-])[A-Za-z0-9+_-]{40,}={0,2}\b/gu],
};

const providerRedactor = createProviderRedactor(TTL_SH_REDACTION_PROFILE);

/**
 * Redact credential-shaped material and flatten control characters, through the
 * shared redactor (`@hobo/provider-redaction`) and ttl.sh's own shapes.
 *
 * Digests survive: a digest is the artifact's identity, not a secret, it appears
 * in every receipt, and a redaction that ate it would make the audit trail
 * useless. It is kept out of the search and put back afterwards.
 */
export function redactProviderText(text: string, maxLength = 256): string {
	return providerRedactor(text, maxLength);
}

function redactOptionalText(value: string | undefined): string | undefined {
	return value === undefined ? undefined : redactProviderText(value, 180);
}

function redactDetail(detail: TtlShErrorDetail): TtlShErrorDetail {
	const method = redactOptionalText(detail.method);
	const body = redactOptionalText(detail.body);
	const header = redactOptionalText(detail.header);
	const guard = redactOptionalText(detail.guard);
	const location = redactOptionalText(detail.location);
	const host = redactOptionalText(detail.host);
	const path = redactOptionalText(detail.path);
	const url = redactOptionalText(detail.url);
	const port = redactOptionalText(detail.port);
	const allowed = redactOptionalText(detail.allowed);
	const binary = redactOptionalText(detail.binary);
	const flag = redactOptionalText(detail.flag);
	const pullReference = redactOptionalText(detail.pullReference);
	const reported = redactOptionalText(detail.reported);
	const declared = redactOptionalText(detail.declared);
	const agreed = redactOptionalText(detail.agreed);
	const requested = redactOptionalText(detail.requested);
	const target = redactOptionalText(detail.target);
	const reference = redactOptionalText(detail.reference);
	const stderr = redactOptionalText(detail.stderr);
	const expected = redactOptionalText(detail.expected);
	return {
		...(detail.status !== undefined ? { status: detail.status } : undefined),
		...(method !== undefined ? { method } : undefined),
		...(body !== undefined ? { body } : undefined),
		...(header !== undefined ? { header } : undefined),
		...(guard !== undefined ? { guard } : undefined),
		...(location !== undefined ? { location } : undefined),
		...(host !== undefined ? { host } : undefined),
		...(path !== undefined ? { path } : undefined),
		...(url !== undefined ? { url } : undefined),
		...(port !== undefined ? { port } : undefined),
		...(allowed !== undefined ? { allowed } : undefined),
		...(binary !== undefined ? { binary } : undefined),
		...(flag !== undefined ? { flag } : undefined),
		...(detail.code !== undefined ? { code: detail.code } : undefined),
		...(pullReference !== undefined ? { pullReference } : undefined),
		...(reported !== undefined ? { reported } : undefined),
		...(declared !== undefined ? { declared } : undefined),
		...(agreed !== undefined ? { agreed } : undefined),
		...(requested !== undefined ? { requested } : undefined),
		...(target !== undefined ? { target } : undefined),
		...(reference !== undefined ? { reference } : undefined),
		...(stderr !== undefined ? { stderr } : undefined),
		...(expected !== undefined ? { expected } : undefined),
	};
}

export class TtlShProviderError extends Error {
	readonly code: TtlShErrorCode;
	readonly retryable: boolean;
	readonly retryAfterMs?: number;
	readonly detail: TtlShErrorDetail;

	constructor(
		code: TtlShErrorCode,
		message: string,
		options: TtlShErrorOptions = {},
	) {
		super(
			redactProviderText(message),
			options.cause !== undefined ? { cause: options.cause } : undefined,
		);
		this.name = "TtlShProviderError";
		this.code = code;
		this.retryable = options.retryable ?? false;
		if (options.retryAfterMs !== undefined)
			this.retryAfterMs = options.retryAfterMs;
		// Detail is redacted as well as the message. A detail field is the more
		// likely leak of the two: it is where tool stderr and response bodies end
		// up, and it is serialised verbatim into receipts and log records.
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

export function isTtlShProviderError(
	value: Error,
): value is TtlShProviderError {
	return value instanceof TtlShProviderError;
}

/** Methods whose repetition is free of consequence. */
const IDEMPOTENT: readonly string[] = ["GET", "HEAD"];

/**
 * Map a registry HTTP status onto a HoBo code.
 *
 * A `401` or `403` is a **contract change**, not an auth failure: the service this
 * package was written against asks for nothing, so being challenged means the thing
 * on the other end is not that service. There is no code path that answers.
 */
export function ttlShErrorForStatus(
	status: number,
	options: {
		readonly method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
		readonly body?: string;
		readonly retryAfterMs?: number;
	},
): TtlShProviderError {
	const body =
		options.body === undefined ? "" : redactProviderText(options.body, 180);
	const detail = {
		status,
		method: options.method,
		...(body ? { body } : undefined),
	};
	if (status === 401 || status === 403) {
		return new TtlShProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`ttl.sh returned ${status}; this transport is anonymous by design, holds no credentials, and will not answer an authentication challenge`,
			{ detail },
		);
	}
	if (status === 404) {
		return new TtlShProviderError(
			"LEASE_EXPIRED",
			"ttl.sh returned 404; the artifact's TTL has elapsed or it was never pushed. Push again rather than retrying.",
			{ detail },
		);
	}
	if (status === 429) {
		return new TtlShProviderError(
			"PROVIDER_RATE_LIMITED",
			"ttl.sh rate limited the request",
			{
				retryable: true,
				...(options.retryAfterMs !== undefined
					? { retryAfterMs: options.retryAfterMs }
					: undefined),
				detail,
			},
		);
	}
	if (status >= 500) {
		// A 5xx on a read is safe to repeat. A 5xx on an upload is
		// indistinguishable from "stored but not acknowledged".
		return IDEMPOTENT.includes(options.method)
			? new TtlShProviderError(
					"PROVIDER_UNAVAILABLE",
					`ttl.sh returned ${status}`,
					{
						retryable: true,
						detail,
					},
				)
			: new TtlShProviderError(
					"PROVIDER_OPERATION_AMBIGUOUS",
					`ttl.sh returned ${status} to a ${options.method}; the artifact may or may not be there`,
					{ detail },
				);
	}
	return new TtlShProviderError(
		"PROVIDER_CONTRACT_CHANGED",
		`ttl.sh returned an unexpected ${status}`,
		{ detail },
	);
}
