// Typed failure modes of the desired-state module (WP4). Every refusal carries a
// stable code and a remediation an operator or agent can act on.
import { create } from "@bufbuild/protobuf";
import { type ReasonRecord, ReasonRecordSchema } from "../_generated/cd_pb.js";
import type { Refusal } from "../ports.js";

// public-contract: refusal codes of the desired-state module.
export const SETS_FAILURES = Object.freeze({
	"delta-invalid": "Fix the Delta record (delta_id, camp_id, intent and schema_version are required) and open it again.",
	"delta-not-found": "Open the Delta first; apply, update and reject act only on a recorded Delta.",
	"delta-overlap": "Apply or reject the Camp's open Delta before opening another (one in-flight Delta per Camp).",
	"delta-stale-base": "Re-resolve against the Camp's current Set and open a new Delta with that base_set_id.",
	"delta-not-open": "The Delta is already applied or rejected; open a new Delta for further changes.",
	"delta-rejected": "The Delta was rejected; open a new Delta to retry.",
	"delta-already-applied": "An applied Delta cannot be rejected; roll back with a new Delta to the predecessor Set (D12).",
	"delta-absent-resource": "Update or remove only resources present in the base Set; add only resources absent from it.",
	"delta-diff-mismatch": "Recompute the Delta's changes with diffResolvedSets(base, resolved) so they describe the Set being applied.",
	"concurrent-apply": "Another writer changed the Camp's desired state first; re-read the current Set and open a new Delta.",
	"gate-decision-missing": "Evaluate the deploy gate and pass its decision id; every Set records the decision that admitted it (I10).",
	"set-origin-invalid": "Pass the SetOrigin that matches the Delta intent; LEGACY_FOLD is written only by adoptLegacy.",
	"resolved-set-invalid": "Rebuild the resolved set with createResolvedDeploymentSet; its plan and content hashes must verify.",
	"resolved-set-camp-mismatch": "Resolve the Set for the Delta's Camp and tenant.",
	"missing-dependency": "Every resource dependency must be present in the same resolved set; fix the declaration or the Matching result.",
	"secret-material": "Replace plaintext secret values with secretRef locators; resolved sets are secret-free by construction (I9).",
	"blob-digest-mismatch": "The artifact store returned a digest that does not match the canonical bytes; check the store backend before retrying.",
	"resolved-set-missing": "Restore the resolved-set blob into the artifact store or re-apply the Set; nothing converges without it.",
	"resolved-set-digest-mismatch": "The stored blob is corrupt; restore it from a replica or re-apply the Set. Promotion stays blocked until then.",
	"journal-invalid": "The Camp spec journal is inconsistent; stop writers for the Camp, inspect the stream and repair it by an operator-reviewed append.",
} as const);

export type SetsFailureCode = keyof typeof SETS_FAILURES;

/** Thrown where a port returns a value rather than an Outcome (resolved(), reject(), folds). */
export class DesiredStateError extends Error {
	readonly code: SetsFailureCode;
	readonly remediation: string;
	readonly subject: string;
	constructor(code: SetsFailureCode, message: string, subject = "", remediation?: string) {
		super(`${code}: ${message}`);
		this.name = "DesiredStateError";
		this.code = code;
		this.subject = subject;
		this.remediation = remediation ?? SETS_FAILURES[code];
	}
	toReason(): ReasonRecord {
		return reason(this.code, this.message, this.subject, this.remediation);
	}
}

export function reason(code: SetsFailureCode, message: string, subject = "", remediation?: string): ReasonRecord {
	return create(ReasonRecordSchema, { code, message, subject, remediation: remediation ?? SETS_FAILURES[code] });
}

export function refuse(code: SetsFailureCode, message: string, subject = "", remediation?: string): Refusal {
	return Object.freeze({ ok: false as const, reasons: Object.freeze([reason(code, message, subject, remediation)]) });
}

export function refusalFrom(error: DesiredStateError): Refusal {
	return Object.freeze({ ok: false as const, reasons: Object.freeze([error.toReason()]) });
}
