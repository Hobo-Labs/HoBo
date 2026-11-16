/**
 * The secret-capture refusals. Every message is written here, from fixed text
 * and parsed names; none quotes a submitted value, a ciphertext, a token or a
 * store's error body.
 */

export type SecretCaptureCode =
	/** No secret store binding: nothing to write to yet. */
	| "SECRET_STORE_NOT_CONNECTED"
	/** A store is bound, but no writer session authorizes writes now. */
	| "SECRET_STORE_WRITER_REQUIRED"
	/** The store refused the writer credential. */
	| "SECRET_STORE_WRITER_DENIED"
	/** The store refused or failed the write. */
	| "SECRET_STORE_WRITE_FAILED"
	| "SECRET_CAPTURE_UNKNOWN_NAME"
	| "SECRET_CAPTURE_UNKNOWN_TICKET"
	| "SECRET_CAPTURE_EXPIRED"
	| "SECRET_CAPTURE_CLOSED"
	/** The value failed its size, charset or shape check (a reason, never the value). */
	| "SECRET_CAPTURE_INVALID_VALUE"
	/** The sealed envelope did not open with the ticket's key. */
	| "SECRET_CAPTURE_SEAL_INVALID"
	| "SECRET_CAPTURE_TOO_MANY_PENDING"
	| "SECRET_CAPTURE_ATTEMPTS_EXHAUSTED"
	| "SECRET_CAPTURE_INVALID_INPUT"
	| "SECRET_CAPTURE_WRITER_CLIENT_ID_REQUIRED"
	/** The app-only submit tool was called by a host that did not negotiate MCP Apps. */
	| "MCP_APPS_NOT_NEGOTIATED";

export class SecretCaptureError extends Error {
	readonly code: SecretCaptureCode;
	readonly nextStep: string | undefined;

	constructor(code: SecretCaptureCode, message: string, nextStep?: string) {
		super(message);
		this.name = "SecretCaptureError";
		this.code = code;
		this.nextStep = nextStep;
	}
}

/**
 * What a store connector throws. `code` is a short machine word the
 * connector chose (`login-denied`, `forbidden`, `unavailable`, ...); it is the
 * only thing about the failure that reaches a refusal.
 */
export class SecretStoreConnectorError extends Error {
	readonly code: string;

	constructor(code: string) {
		const safe = /^[a-z][a-z0-9-]{0,39}$/u.test(code) ? code : "unavailable";
		super(`secret store: ${safe}`);
		this.name = "SecretStoreConnectorError";
		this.code = safe;
	}
}
