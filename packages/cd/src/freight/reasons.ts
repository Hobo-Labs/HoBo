import { create } from "@bufbuild/protobuf";
import { type ReasonRecord, ReasonRecordSchema } from "../_generated/cd_pb.js";
import type { Refusal } from "../ports.js";

export const FREIGHT_REASON = Object.freeze({
	manifestInvalid: "freight-manifest-invalid",
	secretInRecord: "freight-secret-in-record",
	originInvalid: "freight-origin-invalid",
	artifactsUnverified: "freight-artifacts-unverified",
	notFound: "freight-not-found",
	yanked: "freight-yanked",
	retired: "freight-retired",
	reasonRequired: "freight-reason-required",
	campRequired: "freight-camp-required",
	verificationNotPass: "freight-qualification-requires-pass",
	verificationMismatch: "freight-verification-mismatch",
	approvalExpiry: "freight-approval-expiry-invalid",
	ungoverned: "freight-action-ungoverned",
	unauthorized: "freight-action-unauthorized",
	proposalOnly: "freight-proposal-only",
	conflict: "freight-journal-conflict",
	journalUnreadable: "freight-journal-unreadable",
} as const);

export type FreightReasonCode =
	(typeof FREIGHT_REASON)[keyof typeof FREIGHT_REASON];

export function reason(
	code: string,
	message: string,
	remediation: string,
	subject = "",
): ReasonRecord {
	return create(ReasonRecordSchema, { code, message, remediation, subject });
}

export function refuse(
	code: string,
	message: string,
	remediation: string,
	subject = "",
): Refusal {
	return { ok: false, reasons: [reason(code, message, remediation, subject)] };
}

export function refuseWith(
	head: ReasonRecord,
	causes: readonly ReasonRecord[],
): Refusal {
	return { ok: false, reasons: [head, ...causes] };
}
