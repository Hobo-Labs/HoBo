// Typed refusal and skip reasons for Freight sources. Every reason names a
// remediation an operator can act on; codes are wire contract (journal meta,
// CUE `#SourceReasonCode`, the runbook).
import { create } from "@bufbuild/protobuf";
import { type ReasonRecord, ReasonRecordSchema } from "../_generated/cd_pb.js";
import { UNVERIFIED_TRIGGER } from "../events.js";
import type { Refusal } from "../ports.js";

// public-contract: reason codes a source refusal or skip carries.
export const SOURCE_REASON = Object.freeze({
	invalid: "source-invalid",
	unknown: "source-unknown",
	unauthorized: "source-unauthorized",
	driverUnavailable: "source-driver-unavailable",
	provenanceUnsupported: "source-provenance-unsupported",
	provenanceMissing: "source-provenance-missing",
	provenanceRejected: "source-provenance-rejected",
	rateLimited: "source-rate-limited",
	unreachable: "source-unreachable",
	upstreamInvalid: "source-upstream-invalid",
	authFailed: "source-auth-failed",
	notFound: "source-not-found",
	olderThanHighWater: "source-older-than-high-water",
	filtered: "source-filtered",
	retired: "source-rail-retired",
	freightRefused: "source-freight-refused",
	transportNotBinarySafe: "source-transport-not-binary-safe",
	gitCapabilityMissing: "source-git-capability-missing",
	unverifiedTrigger: UNVERIFIED_TRIGGER,
} as const);

export type SourceReasonCode =
	(typeof SOURCE_REASON)[keyof typeof SOURCE_REASON];

export function reason(
	code: SourceReasonCode,
	message: string,
	remediation: string,
	subject = "",
): ReasonRecord {
	return create(ReasonRecordSchema, { code, message, remediation, subject });
}

export function refuse(
	code: SourceReasonCode,
	message: string,
	remediation: string,
	subject = "",
): Refusal {
	return { ok: false, reasons: [reason(code, message, remediation, subject)] };
}

const RETRY_AFTER = /^retry-after-ms:(\d{1,10})$/;

/** A rate-limit refusal carries the server's Retry-After (ms) as its subject. */
export function rateLimited(where: string, retryAfterMs: number): Refusal {
	return refuse(
		SOURCE_REASON.rateLimited,
		`${where} answered with a rate limit`,
		"the source backs off automatically; lower the poll frequency or add a credentialRef with a higher quota",
		`retry-after-ms:${Math.max(0, Math.round(retryAfterMs))}`,
	);
}

export function retryAfterMs(
	reasons: readonly ReasonRecord[],
): number | undefined {
	for (const item of reasons) {
		if (item.code !== SOURCE_REASON.rateLimited) continue;
		const match = RETRY_AFTER.exec(item.subject);
		if (match?.[1] !== undefined) return Number(match[1]);
	}
	return undefined;
}
