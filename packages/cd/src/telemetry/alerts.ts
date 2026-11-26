// Alert rules and SLOs for the CD plane (WP19; handed to WP21 for the
// operator docs). Vendor-neutral data over the metric names in semconv.ts: an
// adapter renders them for whatever alerting backend a Station runs. Each
// threshold comes from CD_DEFAULTS or the R12/R13 decisions, never a guess.
import { CD_DEFAULTS } from "../events.js";
import { CD_METRICS, CICD_METRICS } from "./semconv.js";

export type AlertSeverity = "page" | "ticket";

export type CdAlertRule = Readonly<{
	name: string;
	metric: string;
	/** Attribute filter applied before the comparison. */
	where?: Readonly<Record<string, string>>;
	op: ">" | ">=" | "<" | "<=";
	threshold: number;
	/** The condition must hold this long before firing. */
	forMs: number;
	severity: AlertSeverity;
	summary: string;
	runbook: string;
}>;

export type CdSlo = Readonly<{
	name: string;
	indicator: string;
	objective: number;
	windowMs: number;
	description: string;
}>;

const RUNBOOK = "packages/cd/src/telemetry/README.md#runbook";
const AUTHZ_RUNBOOK = "packages/cd/src/authz/README.md#runbook";

// public-contract: CD plane alert rules (names are stable identifiers).
export const CD_ALERT_RULES: readonly CdAlertRule[] = Object.freeze([
	{
		name: "CdReconcileLagHigh",
		metric: CD_METRICS.reconcileLag,
		op: ">",
		threshold: CD_DEFAULTS.unreachableAfterMs / 1_000,
		forMs: CD_DEFAULTS.noRunTolerationMs,
		severity: "ticket",
		summary:
			"A Camp's status trails its desired Set by more than the unreachable threshold.",
		runbook: RUNBOOK,
	},
	{
		name: "CdChangeFailureRateHigh",
		metric: CD_METRICS.doraChangeFailureRate,
		op: ">",
		threshold: 0.15,
		forMs: 3_600_000,
		severity: "ticket",
		summary:
			"More than 15% of deployments in the DORA window were rolled back.",
		runbook: RUNBOOK,
	},
	{
		name: "CdFanoutFailuresPresent",
		metric: CD_METRICS.fanoutCamps,
		where: { state: "failed" },
		op: ">",
		threshold: 0,
		forMs: 0,
		severity: "ticket",
		summary:
			"A live fan-out has failed Camps (halts at its failure budget, I20).",
		runbook: RUNBOOK,
	},
	{
		name: "CdFailoverInProgress",
		metric: CD_METRICS.failoverCount,
		where: { state: "replacing" },
		op: ">",
		threshold: CD_DEFAULTS.failoverMaxConcurrent - 1,
		forMs: CD_DEFAULTS.failoverGraceMs,
		severity: "page",
		summary:
			"A failover has been replacing a Camp for longer than the grace period.",
		runbook: RUNBOOK,
	},
	{
		name: "CdInformNoncompliantRatioHigh",
		metric: CD_METRICS.complianceNoncompliantRatio,
		where: { "hobo.policy.control": "*", "hobo.policy.mode": "inform" },
		op: ">",
		threshold: CD_DEFAULTS.informMaxNoncompliantRatio,
		forMs: 0,
		severity: "ticket",
		summary:
			"A candidate Rail in INFORM exceeds the R12 noncompliant budget; it will not qualify.",
		runbook: RUNBOOK,
	},
	{
		name: "CdShadowDivergence",
		metric: CD_METRICS.policyShadowDivergence,
		op: ">",
		threshold: CD_DEFAULTS.informMaxShadowDivergence,
		forMs: 0,
		severity: "ticket",
		summary:
			"A candidate Rail decided differently from the enforced Rail (R12 allows 0).",
		runbook: RUNBOOK,
	},
	{
		name: "CdCampUnreachable",
		metric: CD_METRICS.campCondition,
		where: {
			"hobo.camp.condition": "reachable",
			"hobo.camp.condition.status": "false",
		},
		op: ">",
		threshold: 0,
		forMs: CD_DEFAULTS.noRunTolerationMs,
		severity: "ticket",
		summary: "A Camp has been unreachable past the NO_RUN toleration.",
		runbook: RUNBOOK,
	},
	{
		name: "CdCredentialExpiring",
		metric: CD_METRICS.campCondition,
		where: {
			"hobo.camp.condition": "credential_valid",
			"hobo.camp.condition.status": "false",
		},
		op: ">",
		threshold: 0,
		forMs: 0,
		severity: "page",
		summary:
			"An agent credential is expiring or failed rotation (never silent, D19).",
		runbook: RUNBOOK,
	},
	{
		name: "CdAuthorizationUnrecorded",
		metric: CD_METRICS.authzRefusals,
		where: { reason: "cd-authz-unrecorded" },
		op: ">",
		threshold: 0,
		forMs: 300_000,
		severity: "page",
		summary:
			"Decisions cannot be recorded; every CD mutation is refused (fail closed).",
		runbook: AUTHZ_RUNBOOK,
	},
	{
		name: "CdTelemetryExportFailing",
		metric: CD_METRICS.exportFailures,
		op: ">",
		threshold: 0,
		forMs: 900_000,
		severity: "ticket",
		summary: "CD metrics are not reaching the OTLP collector.",
		runbook: RUNBOOK,
	},
	{
		name: "CdPipelineRunErrors",
		metric: CICD_METRICS.pipelineRunErrors,
		op: ">",
		threshold: 0,
		forMs: 0,
		severity: "ticket",
		summary: "Promotion runs are ending in error.",
		runbook: RUNBOOK,
	},
]);

// public-contract: CD plane SLOs.
export const CD_SLOS: readonly CdSlo[] = Object.freeze([
	{
		name: "reconcile-convergence",
		indicator: `${CD_METRICS.reconcileLag} <= ${CD_DEFAULTS.unreachableAfterMs / 1_000}s`,
		objective: 0.99,
		windowMs: 28 * 86_400_000,
		description:
			"99% of Camp-minutes converge within the unreachable threshold.",
	},
	{
		name: "promotion-success",
		indicator: `1 - ${CD_METRICS.doraChangeFailureRate}`,
		objective: 0.95,
		windowMs: 28 * 86_400_000,
		description: "95% of deployments are not rolled back.",
	},
	{
		name: "authorization-recorded",
		indicator: `${CD_METRICS.authzRefusals}{reason=cd-authz-unrecorded} == 0`,
		objective: 0.999,
		windowMs: 28 * 86_400_000,
		description:
			"99.9% of authorization decisions are recorded on the first try.",
	},
	{
		name: "telemetry-export",
		indicator: `${CD_METRICS.exportFailures} == 0`,
		objective: 0.99,
		windowMs: 7 * 86_400_000,
		description: "99% of export cycles reach the collector.",
	},
]);
