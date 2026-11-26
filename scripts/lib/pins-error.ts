/**
 * The one error type of the pin code: every refusal carries a code a caller
 * (and a test) can match, and its message starts with that code.
 *
 * Erasable TypeScript with node builtins only.
 */
export type PinsErrorCode =
	| "PINS_MALFORMED"
	| "TARGET_UNSUPPORTED"
	| "ASSET_UNPUBLISHED"
	| "DIGEST_MISMATCH"
	| "SIZE_EXCEEDED"
	| "SIZE_MISMATCH"
	| "HTTP_STATUS"
	| "NETWORK"
	| "REDIRECT_REFUSED"
	| "SUMS_MALFORMED"
	| "TARGET_DROPPED"
	| "GIT_FAILED"
	| "SUBMODULE_STATE"
	| "NOT_PUSHED"
	| "CACHE_UNSAFE"
	| "OVERRIDE_IN_CI"
	| "INTERRUPTED"
	| "NET_TIMEOUT"
	| "GITMODULES_AMBIGUOUS"
	| "ARCHIVE_MALFORMED"
	| "ARCHIVE_UNREADABLE"
	| "ARCHIVE_UNSUPPORTED"
	| "ARCHIVE_MEMBER_MISSING"
	| "ARCHIVE_UNSAFE"
	| "ARCHIVE_WRITE_FAILED"
	| "USAGE";

/** Every refusal is named; a bare Error would be untraceable. */
export class PinsError extends Error {
	readonly code: PinsErrorCode;
	/** Errors raised while cleaning up after this one, which must not replace it. */
	readonly suppressed: readonly Error[];
	/** `cause` keeps the error underneath, such as a file system error and its errno. */
	constructor(
		code: PinsErrorCode,
		message: string,
		options?: {
			readonly cause?: unknown;
			readonly suppressed?: readonly Error[];
		},
	) {
		super(
			`${code}: ${message}`,
			options?.cause === undefined ? undefined : { cause: options.cause },
		);
		this.name = "PinsError";
		this.code = code;
		this.suppressed = options?.suppressed ?? [];
	}

	/** This error again, with `note` added to the end of its message. */
	withNote(note: string): PinsError {
		return new PinsError(
			this.code,
			`${this.message.slice(this.code.length + 2)}; ${note}`,
			{ cause: this.cause, suppressed: this.suppressed },
		);
	}

	/** This error again, with `also` (a failure while `step`) recorded beside it and named in the message. */
	withSuppressed(step: string, also: Error): PinsError {
		return new PinsError(
			this.code,
			`${this.message.slice(this.code.length + 2)}; ${step} afterwards failed too: ${also.message}`,
			{ cause: this.cause, suppressed: [...this.suppressed, also] },
		);
	}
}
