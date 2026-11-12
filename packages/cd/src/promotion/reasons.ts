import { create } from "@bufbuild/protobuf";
import {
	type ReasonRecord,
	ReasonRecordSchema,
} from "../_generated/cd_pb.js";
import {
	FANOUT_BUDGET_EXCEEDED,
	LINEAGE_UNSATISFIED,
	OWNERSHIP_CONFLICT,
	SHADOW_REQUIRED,
	WINDOW_CLOSED,
} from "../events.js";
import type { Refusal } from "../ports.js";

// public-contract: refusal and failure codes the promotion saga records. Every
// reason carries a remediation; the frozen codes from events.ts are reused.
export const PROMOTION_REASON = Object.freeze({
	unauthorized: "promotion-unauthorized",
	invalidRequest: "promotion-request-invalid",
	idempotencyReused: "promotion-idempotency-key-reused",
	freightUnknown: "promotion-freight-unknown",
	freightUnusable: "promotion-freight-unusable",
	lineage: LINEAGE_UNSATISFIED,
	shadowRequired: SHADOW_REQUIRED,
	pipelineUnknown: "promotion-pipeline-unknown",
	targetOutsideNode: "promotion-target-outside-node",
	superseded: "promotion-superseded",
	resolveFailed: "promotion-resolve-failed",
	resolutionChanged: "promotion-resolution-changed",
	deltaRefused: "promotion-delta-refused",
	gateDenied: "promotion-gate-denied",
	windowClosed: WINDOW_CLOSED,
	ownershipConflict: OWNERSHIP_CONFLICT,
	approvalDenied: "promotion-approval-denied",
	approvalExpired: "promotion-approval-expired",
	notAwaitingApproval: "promotion-not-awaiting-approval",
	hookFailed: "promotion-hook-failed",
	trailsUnavailable: "promotion-trails-unavailable",
	trailsFailed: "promotion-trails-failed",
	applyFailed: "promotion-apply-failed",
	bindFailed: "promotion-policy-bind-failed",
	rolloutFailed: "promotion-rollout-failed",
	verificationFailed: "promotion-verification-failed",
	qualifyFailed: "promotion-qualify-failed",
	compensated: "promotion-group-compensated",
	fanoutBudget: FANOUT_BUDGET_EXCEEDED,
	fanoutAggregateUnavailable: "promotion-fanout-aggregate-unavailable",
	rollbackNoPredecessor: "rollback-no-predecessor",
	rollbackPastContract: "rollback-past-contract",
	rollbackTargetUnusable: "rollback-target-unusable",
	notFound: "promotion-not-found",
	journalConflict: "promotion-journal-conflict",
	previewInvalid: "preview-invalid",
	previewTeardownRefused: "preview-teardown-refused",
} as const);

export type PromotionReasonCode =
	(typeof PROMOTION_REASON)[keyof typeof PROMOTION_REASON];

// public-contract: metric names the promotion saga emits through TelemetrySink.
export const PROMOTION_METRIC = Object.freeze({
	requested: "hobo.cd.promotion.requested",
	refused: "hobo.cd.promotion.refused",
	step: "hobo.cd.promotion.step",
	stepError: "hobo.cd.promotion.step_error",
	promoted: "hobo.cd.promotion.promoted",
	failed: "hobo.cd.promotion.failed",
	superseded: "hobo.cd.promotion.superseded",
	compensated: "hobo.cd.promotion.compensated",
	rolledBack: "hobo.cd.promotion.rolled_back",
	leadTime: "hobo.cd.promotion.lead_time",
	previewCreated: "hobo.cd.preview.created",
	previewExpired: "hobo.cd.preview.expired",
	shadowDiverged: "hobo.cd.gate.shadow_diverged",
	gateDecided: "hobo.cd.gate.decided",
	hookRun: "hobo.cd.hook.run",
	approvalRequested: "hobo.cd.approval.requested",
	approvalDecided: "hobo.cd.approval.decided",
} as const);

/** Build one ReasonRecord; every refusal names a remediation. */
export function reason(
	code: string,
	message: string,
	remediation: string,
	subject = "",
): ReasonRecord {
	return create(ReasonRecordSchema, { code, message, remediation, subject });
}

export function refuse(...reasons: ReasonRecord[]): Refusal {
	return { ok: false, reasons };
}
