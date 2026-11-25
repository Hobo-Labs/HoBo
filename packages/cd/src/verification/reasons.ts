// Every typed failure the verification engine and health sources report. Each
// code carries a remediation, so a FAIL or a refusal always says what to do.
import { create } from "@bufbuild/protobuf";
import { type ReasonRecord, ReasonRecordSchema } from "../_generated/cd_pb.js";
import type { Refusal } from "../ports.js";

// public-contract: verification reason codes and their remediations.
export const VERIFICATION_REASONS = Object.freeze({
	"verification-spec-invalid":
		"Fix the named field of the VerificationSpec; data-models/verification.cue lists the constraints.",
	"verification-spec-empty":
		"Declare at least one threshold, comparison, probe or suite: a spec with no checks would pass on absent evidence.",
	"verification-deadline-before-window":
		"Set progress_deadline_ms to at least window_ms (default 30 min against a 10 min window).",
	"verification-duplicate-check":
		"Give every query, probe and suite in one spec a distinct name.",
	"verification-error-budget-unbound":
		'max_error_budget_burn needs a threshold or comparison query whose unit is "burn_rate"; add one or set the ceiling to 0.',
	"verification-probe-interval-exceeds-window":
		"Lower the probe interval_ms below window_ms so the window can hold an observation.",
	"verification-no-data":
		"The health source returned no samples for the window. Check the query, the cohort label and that the target emits the metric; absent evidence never passes.",
	"verification-insufficient-observations":
		"Fewer samples than required_observations arrived before the progress deadline. Widen the window, lower the step or fix the scrape.",
	"verification-deadline-exceeded":
		"The progress deadline passed before every check had evidence; the rollout treats INCONCLUSIVE as FAIL.",
	"verification-threshold-breached":
		"The aggregated value broke the threshold; inspect the canary, then roll back or fix forward.",
	"verification-canary-worse":
		"The canary is significantly worse than the baseline (Mann–Whitney U); roll back and compare the two cohorts.",
	"verification-cohort-unavailable":
		"Canary-vs-baseline comparisons need a cohort-aware rollout (a traffic split with a baseline); use thresholds for this strategy.",
	"verification-probe-failed":
		"The probe success ratio fell below min_success_ratio; check the endpoint and the expected status.",
	"verification-suite-failed":
		"The verify suite failed; read its result and fix the release before promoting again.",
	"verification-error-budget-exhausted":
		"The error-budget burn rate exceeded max_error_budget_burn; hold promotions until the budget recovers.",
	"verification-invalid-sample":
		"The source returned a non-finite value or a ratio outside [0, 1]; fix the query so it yields a valid series.",
	"verification-source-unavailable":
		"The health source refused or failed; it is retried every tick until the progress deadline.",
	"health-source-unconfigured":
		"Register a health source of this kind (createHealthSources) or change the query's source.",
	"health-source-endpoint-invalid":
		"endpoint_ref must be an absolute https URL of the source API.",
	"health-source-query-invalid":
		"Fix the query string for this source kind (see verification/sources/README.md).",
	"health-source-credential-unavailable":
		"The credential_ref did not resolve; store the credential where the reconciler runs.",
	"health-source-http-error":
		"The source API answered with an error status; check credentials, quota and the query.",
	"health-source-response-invalid":
		"The source API answered with a body that does not match its contract; check the API version.",
	"health-source-transport-failed":
		"The request did not complete (timeout, guard or network); it is retried every tick until the deadline.",
	"health-source-cohort-label-missing":
		"Declare cohort_label on the query so canary and baseline can be selected.",
} as const);

export type VerificationReasonCode = keyof typeof VERIFICATION_REASONS;

export function reason(
	code: VerificationReasonCode,
	message: string,
	subject = "",
): ReasonRecord {
	return create(ReasonRecordSchema, {
		code,
		message,
		remediation: VERIFICATION_REASONS[code],
		subject,
	});
}

export function refuse(
	code: VerificationReasonCode,
	message: string,
	subject = "",
): Refusal {
	return { ok: false, reasons: [reason(code, message, subject)] };
}
