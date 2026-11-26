// Typed failure codes and metric names of the posture module (WP24). Every
// refusal carries a remediation; metric names follow the plan (§9 WP19).
import { OWNERSHIP_CONFLICT, SHADOW_REQUIRED } from "../events.js";

// public-contract: reason codes the posture module records or refuses with.
export const POSTURE_REASON = Object.freeze({
	notRail: "policy-bind-not-rail",
	digestInvalid: "policy-bind-digest-invalid",
	modeInvalid: "policy-bind-mode-invalid",
	proposalOnly: "policy-bind-proposal-only",
	shadowRequired: SHADOW_REQUIRED,
	restoreUnknown: "policy-restore-unknown",
	restoreSuperseded: "policy-restore-superseded",
	journalConflict: "policy-journal-conflict",
	shadowInvalid: "policy-shadow-invalid",
	ownershipConflict: OWNERSHIP_CONFLICT,
	drift: "posture-drift",
	retained: "posture-unremediable-retained",
	noFix: "posture-unremediable-no-fix",
	setUnavailable: "posture-set-unavailable",
	enforceUnauthorized: "posture-enforce-unauthorized",
	deltaRefused: "posture-delta-refused",
	proposed: "posture-remediation-proposed",
	fix: "posture-fix",
	packInvalid: "posture-pack-invalid",
	candidateUnresolved: "posture-candidate-unresolved",
} as const);

// public-contract: metric names the posture module emits through TelemetrySink.
export const POSTURE_METRIC = Object.freeze({
	noncompliantRatio: "hobo.cd.compliance.noncompliant_ratio",
	shadowDivergence: "hobo.cd.policy.shadow_divergence",
	shadowDecisions: "hobo.cd.policy.shadow_decisions",
	bindingChanged: "hobo.cd.policy.binding_changed",
	evaluations: "hobo.cd.posture.evaluations",
	complianceChanged: "hobo.cd.posture.compliance_changed",
	remediations: "hobo.cd.posture.remediations",
	ownershipConflicts: "hobo.cd.posture.ownership_conflicts",
	packInvalid: "hobo.cd.posture.pack_invalid",
	noObservation: "hobo.cd.posture.no_observation",
	refusals: "hobo.cd.posture.refusals",
} as const);

/** A journal append lost every CAS attempt or the store failed; the caller retries. */
export class PostureJournalError extends Error {
	readonly code: string;
	readonly remediation: string;
	constructor(code: string, message: string, remediation: string) {
		super(`${code}: ${message}`);
		this.name = "PostureJournalError";
		this.code = code;
		this.remediation = remediation;
	}
}
