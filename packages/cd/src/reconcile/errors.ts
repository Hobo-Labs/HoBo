// Typed failure modes of the reconcile module (WP7, plan 0024). Every refusal
// and every blocked observation carries a stable code plus a remediation an
// operator or agent can act on.
import { create } from "@bufbuild/protobuf";
import { type ReasonRecord, ReasonRecordSchema } from "../_generated/cd_pb.js";
import type { Refusal } from "../ports.js";

// public-contract: reason codes the reconcile module writes.
export const RECONCILE_FAILURES = Object.freeze({
	"lease-held":
		"Another reconciler holds the Camp lease (I4). Wait for it to expire or revoke that reconciler; never run two writers for one Camp.",
	"stale-fence":
		"This reconciler lost the Camp lease to a newer holder; it stopped before mutating. Nothing to do unless the newer holder is unexpected.",
	"lease-unsupported":
		"The event store has no durable subscription leases; run the reconciler on @hobo/storage-sqlite, @hobo/storage-postgres or a runtime that provides claimSubscription.",
	"store-unavailable":
		"The journal failed while claiming, reporting or checkpointing; the reconciler backs off and retries. Check storage health.",
	"checkpoint-regression":
		"A checkpoint older than the committed one was refused; restart the reconciler so it resumes from the committed position.",
	"resolved-set-missing":
		"Restore the resolved-set blob into the artifact store (or re-apply the Set); the Camp stays blocked until the digest verifies.",
	"resolved-set-mismatch":
		"The resolved set does not match the Set's content hash; promotion never rebuilds (I1). Restore the original blob or re-promote the Freight.",
	"realize-failed":
		"The realizer failed; inspect the reason, fix the provider or credentials, and the next pass retries by observation.",
	"realize-blocked":
		"The realizer refused the change; read the reason and fix the declaration or the provider capability.",
	"attestation-refused":
		"The apply worker could not be attested; check the host attestor keys and the code digest before retrying.",
	"report-refused":
		"The status report was refused; the reconciler retries on the next pass. Check the transport and lease.",
	"drift-detected":
		"The target diverged from the desired Set; the Camp's DriftPolicy routed it (see the accompanying reason).",
	"drift-reconciled":
		"Drift was remediated by re-applying the Camp's current Set; no new Delta was needed.",
	"drift-proposed":
		"A drift diff was proposed; review drift.DiffProposed and approve a drift-remediate Delta or adopt the change in the declaration.",
	"drift-ignored":
		"Drift was recorded and ignored by policy; change the DriftPolicy if this resource class should be remediated.",
	"drift-escalated":
		"Drift needs a human: it oscillated after remediation, exceeded the blast-radius budget, or touched a data resource. Investigate before re-applying.",
	"drift-detect-only":
		"External or echo resources are detected but never re-applied; adopt the observed value in the declaration if it is intended.",
	"orphan-foreign":
		"A resource tagged for another deployment was observed; it is never swept. Remove it from this Camp's scope or fix its tags.",
	"observe-only":
		"The Camp is OBSERVE_ONLY: it is read and reported, never applied. Promote it to MANAGED (camp.manage) to converge it.",
	"attribute-truncated":
		"An observed attribute exceeded the 16 KiB per-resource bound and was truncated (its digest is kept). Narrow the bound pack's observe_fields.",
	"attribute-dropped":
		"An observed attribute did not fit the 16 KiB per-resource bound and was dropped with this reason. Narrow the bound pack's observe_fields.",
	"attribute-undeclared":
		"An attribute outside the bound packs' observe_fields was removed; reconcilers report only declared fields.",
	"attribute-secret-redacted":
		"An observed value looked like secret material and was replaced by a secretRef (I9). Fix the resolver so it never reports secrets.",
	"handover-secret-redacted":
		"A handover output looked like secret material and was replaced by a secretRef (I9).",
	"departure-orphaned":
		"The Camp departed; resources kept by its DepartureAction are recorded in camp.Departed and remain on the target until purged.",
	"departure-keep-violated":
		"The realizer removed a resource the DepartureAction keeps; restore it from backup and fix the realizer to honour `keep`.",
	"invalid-observation":
		"The realizer returned an observation that does not satisfy data-models/reconcile.cue; fix the realizer.",
} as const);

export type ReconcileFailureCode = keyof typeof RECONCILE_FAILURES;

export function reason(
	code: ReconcileFailureCode,
	message: string,
	subject = "",
	remediation?: string,
): ReasonRecord {
	return create(ReasonRecordSchema, {
		code,
		message,
		remediation: remediation ?? RECONCILE_FAILURES[code],
		subject,
	});
}

export function refuse(
	code: ReconcileFailureCode,
	message: string,
	subject = "",
): Refusal {
	return Object.freeze({
		ok: false as const,
		reasons: Object.freeze([reason(code, message, subject)]),
	});
}

/** Error carrying a typed reason, thrown only where a port returns a value. */
export class ReconcileError extends Error {
	readonly code: ReconcileFailureCode;
	readonly subject: string;
	constructor(code: ReconcileFailureCode, message: string, subject = "") {
		super(`${code}: ${message}`);
		this.name = "ReconcileError";
		this.code = code;
		this.subject = subject;
	}
	toReason(): ReasonRecord {
		return reason(this.code, this.message, this.subject);
	}
}

export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
