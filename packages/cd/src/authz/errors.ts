// Typed failure modes of delivery authorization (WP19, D15, I10). Every
// refusal carries a stable code and a remediation an operator can act on.
import { create } from "@bufbuild/protobuf";
import { type ReasonRecord, ReasonRecordSchema } from "../_generated/cd_pb.js";
import type { Refusal } from "../ports.js";

// public-contract: refusal codes of `@hobo/cd/authz` with remediation.
export const AUTHZ_FAILURES = Object.freeze({
	"cd-authz-denied": {
		remediation:
			"The policy pack denied this action. Read the recorded decision (subject = decision id) for the rule and reason, then request the grant from the pack owner.",
	},
	"separation-of-duties": {
		remediation:
			"The two enrollment grants (`reconciler.approve-key`, `reconciler.accept`) need two different principals (R14). Ask a second operator to grant the other half.",
	},
	"cd-authz-unrecorded": {
		remediation:
			"The decision could not be recorded, so the action is refused (fail closed, I10). Check the event store's health and retry; nothing was changed.",
	},
	"cd-authz-unknown-action": {
		remediation:
			"Only the frozen `CdAction` vocabulary is authorized. Fix the caller to use one of `CD_ACTIONS`.",
	},
	"cd-authz-tenant-mismatch": {
		remediation:
			"The request context names a different tenant than this authorizer serves. Route the request to its own tenant's authorizer.",
	},
	"cd-authz-policy-error": {
		remediation:
			"A policy rule threw while deciding, so the action is denied (fail closed). Fix the rule in the policy pack and retry.",
	},
} as const);

export type AuthzFailureCode = keyof typeof AUTHZ_FAILURES;

export function authzReason(
	code: AuthzFailureCode,
	message: string,
	subject: string,
): ReasonRecord {
	return create(ReasonRecordSchema, {
		code,
		message,
		remediation: AUTHZ_FAILURES[code].remediation,
		subject,
	});
}

export function authzRefusal(
	code: AuthzFailureCode,
	message: string,
	subject: string,
): Refusal {
	return { ok: false, reasons: [authzReason(code, message, subject)] };
}
