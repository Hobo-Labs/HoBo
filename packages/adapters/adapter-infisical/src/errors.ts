export type InfisicalErrorCode =
	/** A binding, identity or secret name failed its parser. */
	| "invalid-input"
	/** The workload identity token could not be obtained. */
	| "jwt-unavailable"
	/** Infisical refused the login (identity, JWT claims or credentials). */
	| "login-denied"
	/** A request was answered 401 after one fresh login. */
	| "unauthorized"
	/** The identity may not read or write this project, environment or path. */
	| "forbidden"
	| "not-found"
	/** Infisical answered 400 or 422 to a request this adapter made. */
	| "rejected"
	/** Still 429 after the retry budget. */
	| "rate-limited"
	/** Still 5xx or unreachable after the retry budget. */
	| "unavailable"
	| "write-uncertain"
	/** The independently enrolled plan-observation lease could not be verified. */
	| "lease-unverified"
	/** The host did not reserve and claim a plan-observation attempt. */
	| "budget-unavailable"
	/** A secret-protection policy turned a write into a pending approval. */
	| "approval-required"
	/** The identity may list the secret but not read its value. */
	| "value-hidden"
	/** A 2xx answer that does not have the documented shape. */
	| "invalid-response";

export class InfisicalError extends Error {
	readonly code: InfisicalErrorCode;
	readonly status: number | undefined;
	readonly reqId: string | undefined;
	readonly retryable: boolean;

	constructor(
		operation: string,
		code: InfisicalErrorCode,
		details: {
			readonly status?: number | undefined;
			readonly reqId?: string | undefined;
			readonly retryable?: boolean;
		} = {},
	) {
		super(
			`infisical ${operation} failed: ${code}${
				details.status === undefined ? "" : ` (HTTP ${details.status})`
			}${details.reqId === undefined ? "" : ` reqId=${details.reqId}`}`,
		);
		this.name = "InfisicalError";
		this.code = code;
		this.status = details.status;
		this.reqId = details.reqId;
		this.retryable = details.retryable ?? false;
	}
}
