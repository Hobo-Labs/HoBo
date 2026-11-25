import { create } from "@bufbuild/protobuf";
import { type ReasonRecord, ReasonRecordSchema } from "../_generated/cd_pb.js";
import type { Refusal } from "../ports.js";

// public-contract: refusal codes the change-window service returns. Every
// refusal carries a remediation an operator can act on.
export const WINDOW_REASON = Object.freeze({
	invalid: "window-invalid",
	rruleInvalid: "window-rrule-invalid",
	timezoneInvalid: "window-timezone-invalid",
	notFound: "window-not-found",
	overrideInvalid: "window-override-invalid",
	overrideTooLong: "window-override-too-long",
	ungoverned: "window-action-ungoverned",
	unauthorized: "window-action-unauthorized",
	proposalOnly: "window-proposal-only",
	conflict: "window-journal-conflict",
} as const);

// public-contract: metric names the change-window service emits.
export const WINDOW_METRIC = Object.freeze({
	defined: "hobo.cd.windows.defined",
	overridden: "hobo.cd.windows.overridden",
	refused: "hobo.cd.windows.refused",
	evaluated: "hobo.cd.windows.evaluated",
	unreadable: "hobo.cd.windows.unreadable",
} as const);

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
