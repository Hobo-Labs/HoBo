/**
 * The one error this adapter throws. Its message names the operation, a code,
 * the HTTP status and Infisical's request id: never a response body, a token,
 * a JWT or a secret value, because Infisical's error bodies may echo input.
 */

import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { InfisicalErrorEnvelopeSchema } from "./_generated/adapter_infisical_pb.js";

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

/** Infisical's request id from an error body, when it is a plain token. */
export function requestIdOf(body: JsonValue | undefined): string | undefined {
	if (body === undefined) return undefined;
	try {
		const { reqId } = fromJson(InfisicalErrorEnvelopeSchema, body, {
			ignoreUnknownFields: true,
		});
		return /^[A-Za-z0-9_-]{1,128}$/u.test(reqId) ? reqId : undefined;
	} catch {
		return undefined;
	}
}
