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

export class PinsError extends Error {
	readonly code: PinsErrorCode;
	readonly suppressed: readonly Error[];
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

	withNote(note: string): PinsError {
		return new PinsError(
			this.code,
			`${this.message.slice(this.code.length + 2)}; ${note}`,
			{ cause: this.cause, suppressed: this.suppressed },
		);
	}

	withSuppressed(step: string, also: Error): PinsError {
		return new PinsError(
			this.code,
			`${this.message.slice(this.code.length + 2)}; ${step} afterwards failed too: ${also.message}`,
			{ cause: this.cause, suppressed: [...this.suppressed, also] },
		);
	}
}
