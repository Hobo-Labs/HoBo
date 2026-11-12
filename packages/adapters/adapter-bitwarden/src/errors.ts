/**
 * The one error this adapter throws. Its message names the operation and a
 * code, never a value, a token or the SDK's own error text.
 */

export type BitwardenErrorCode =
	| "invalid-input"
	| "not-found"
	| "unavailable"
	| "invalid-response";

export class BitwardenError extends Error {
	readonly code: BitwardenErrorCode;

	constructor(operation: string, code: BitwardenErrorCode) {
		super(`bitwarden ${operation} failed: ${code}`);
		this.name = "BitwardenError";
		this.code = code;
	}
}
