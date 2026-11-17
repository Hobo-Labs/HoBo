export type SecretCaptureCode =
	| "SECRET_STORE_NOT_CONNECTED"
	| "SECRET_STORE_WRITER_REQUIRED"
	| "SECRET_STORE_WRITER_DENIED"
	| "SECRET_STORE_WRITE_FAILED"
	| "SECRET_CAPTURE_UNKNOWN_NAME"
	| "SECRET_CAPTURE_UNKNOWN_TICKET"
	| "SECRET_CAPTURE_EXPIRED"
	| "SECRET_CAPTURE_CLOSED"
	| "SECRET_CAPTURE_INVALID_VALUE"
	| "SECRET_CAPTURE_SEAL_INVALID"
	| "SECRET_CAPTURE_TOO_MANY_PENDING"
	| "SECRET_CAPTURE_ATTEMPTS_EXHAUSTED"
	| "SECRET_CAPTURE_INVALID_INPUT"
	| "SECRET_CAPTURE_AUDIT_UNAVAILABLE"
	| "SECRET_CAPTURE_WRITER_CLIENT_ID_REQUIRED"
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

export class SecretStoreConnectorError extends Error {
	readonly code: string;

	constructor(code: string) {
		const safe = /^[a-z][a-z0-9-]{0,39}$/u.test(code) ? code : "unavailable";
		super(`secret store: ${safe}`);
		this.name = "SecretStoreConnectorError";
		this.code = safe;
	}
}
