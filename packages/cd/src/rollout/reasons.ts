// Every typed failure the rollout orchestrator and its adapters report. Each
// code carries a remediation, so a refusal, hold or rollback always says what
// to do next (production obligation).
import { create } from "@bufbuild/protobuf";
import { type ReasonRecord, ReasonRecordSchema } from "../_generated/cd_pb.js";
import { PROGRESSIVE_UNSUPPORTED, WINDOW_CLOSED } from "../events.js";
import type { Refusal } from "../ports.js";

// public-contract: rollout reason codes and their remediations.
export const ROLLOUT_REASONS = Object.freeze({
	[PROGRESSIVE_UNSUPPORTED]:
		"No traffic offering on this Camp can realize the strategy (edge.canary, lb.weighted, dns.weighted, inprocess.weighted), or policy forbids the fallback rung. Add a traffic profile for the provider, or choose ROLLOUT_STRATEGY_ALL_AT_ONCE explicitly.",
	"rollout-stages-invalid":
		"Stage percents must be ascending integers in (0, 100]; blue/green and all-at-once take [100]. Leave them empty to use CD_RAMP_DEFAULTS.",
	"rollout-targets-missing":
		"The promotion names no target Camps; a rollout needs at least one.",
	"rollout-freight-missing":
		"The promotion carries no Freight id; promote a recorded Freight.",
	"rollout-promotion-missing":
		"The promotion carries no promotion id; plan the rollout from a recorded promotion.",
	"rollout-unplanned":
		"run() needs a plan recorded by plan(); call plan() with the promotion first.",
	"rollout-plan-refused":
		"The plan was refused at lowering; read its lowering refusals, fix the cause and plan again.",
	"rollout-plan-mismatch":
		"The plan passed to run() differs from the one recorded for this rollout id; re-plan instead of editing a plan record.",
	"rollout-unknown": "No rollout with this id was planned in this tenant.",
	"rollout-awaiting-convergence":
		"The target Camp's reconciler has not reported CONVERGED for the current Set yet; the rollout waits (bounded by the progress deadline).",
	"rollout-camp-blocked":
		"The target Camp's reconciler reported BLOCKED for the promoted Set; a blocked report does not progress, so the rollout fails the Camp closed and rolls back without waiting for the progress deadline. Fix the cause in the reconciler's reasons and promote again.",
	"rollout-traffic-unconverged":
		"The provider acknowledged the shift but observed traffic is not the requested split; the rollout re-observes until the progress deadline. Provider self-report never counts as convergence.",
	"rollout-progress-deadline":
		"Observation did not confirm progress before the progress deadline; the rollout fails closed and rolls back. Inspect the Camp's reconcile status and the Station routing state.",
	"rollout-verification-failed":
		"Verification returned FAIL or INCONCLUSIVE for this stage; the rollout rolls back (D12). Read the verification checks for the cause.",
	"rollout-shift-failed":
		"The Station cutover did not realize the stage; the rollout resolves the outcome by observation and rolls back at the deadline.",
	[WINDOW_CLOSED]:
		"A change window is closed for a target Camp; the rollout holds at the stage boundary and resumes when the window opens. Request a governed override (window.override) to proceed early.",
	"rollout-rollback-window-closed":
		"A freeze that forbids rollback is active; the rollback holds until the window opens or an override is recorded.",
	"rollout-experiment-running":
		"The experiment has not concluded; the rollout holds at the experiment stage until experiment.Concluded is recorded.",
	"rollout-experiment-rejected":
		"The experiment concluded do-not-ship or inconclusive; the rollout rolls back.",
	"rollout-approval-pending":
		"A stage approval is pending; approve it through the approval port to continue.",
	"rollout-approval-denied":
		"The stage approval was denied or expired; the rollout rolls back.",
	"canary-capacity-unavailable":
		"The hosting budget authority refused to reserve capacity for the canary; raise the Station budget or reduce the canary footprint.",
	"canary-capacity-unconfigured":
		"Plan obligations require a hosting-budget reservation but no canary capacity port is composed; compose capacity from the shared hosting budget authority.",
	"rollback-requested":
		"An operator or the promotion saga requested rollback; exposure goes to zero, then a rollback Delta to the predecessor Set goes through the gate.",
	"rollback-no-predecessor":
		"The Camp has no predecessor Set to roll back to; exposure is zero, and teardown (intent down) is the compensating action.",
	"rollback-non-convergeable":
		"Zero exposure could not be observed before the deadline; a human must restore routing (needs-human). The Station routing state names the pending plan.",
	"rollback-delta-opened":
		"A rollback Delta to the predecessor Set is open; the promotion gate applies it through the reconciler (I7).",
	"traffic-unconfigured":
		"No Station routing context is composed for this Camp; traffic cannot be shifted.",
	"traffic-cutover-refused":
		"The Station cutover refused the shift before any provider effect; read the cutover reasons.",
	"traffic-cutover-rolled-back":
		"The Station cutover's destination health gate failed and it restored the prior plan.",
	"traffic-cutover-pending":
		"The provider outcome is ambiguous; it is resolved by observation only, never by a blind retry.",
	"analysis-webhook-unavailable":
		"The analysis webhook failed or answered outside its contract; absent evidence never passes, so the check has no data.",
	"analysis-webhook-unconfigured":
		"The query's endpoint_ref is not an analysis webhook this source serves.",
} as const);

export type RolloutReasonCode = keyof typeof ROLLOUT_REASONS;

export function reason(
	code: RolloutReasonCode,
	message: string,
	subject = "",
): ReasonRecord {
	return create(ReasonRecordSchema, {
		code,
		message,
		remediation: ROLLOUT_REASONS[code],
		subject,
	});
}

export function refuse(
	code: RolloutReasonCode,
	message: string,
	subject = "",
): Refusal {
	return { ok: false, reasons: [reason(code, message, subject)] };
}
