/**
 * The one error this adapter throws. Its message names the operation and a
 * code, never a value, a token or the SDK's own error text (which may quote
 * what it was given).
 */

export type OnePasswordErrorCode =
	| "invalid-input"
	| "not-found"
	| "unavailable"
	| "invalid-response";

export class OnePasswordError extends Error {
	readonly code: OnePasswordErrorCode;

	constructor(operation: string, code: OnePasswordErrorCode) {
		super(`1password ${operation} failed: ${code}`);
		this.name = "OnePasswordError";
		this.code = code;
	}
}
