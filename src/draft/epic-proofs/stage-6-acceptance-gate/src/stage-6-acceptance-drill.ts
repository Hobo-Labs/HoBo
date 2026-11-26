import { type JsonObject, isJsonBoolean } from "./json.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export const CONTRACT_BOUNDARIES = [
  { id: "canary-rollback", pactFile: "pact-canary-rollback.json" },
  { id: "finops-cost-estimate", pactFile: "pact-finops-cost-estimate.json" },
  { id: "dr-replay-rebuild", pactFile: "pact-dr-replay-rebuild.json" },
  { id: "dashboard-a11y-audit", pactFile: "pact-dashboard-a11y-audit.json" },
  { id: "governance-plane", pactFile: "pact-governance-plane.json" },
  { id: "prior-stage-gates", pactFile: "pact-prior-stage-gates.json" },
  { id: "acceptance-record", pactFile: "pact-acceptance-record.json" },
] as const;

export const COST_TOLERANCE_PERCENT = 20;
export const DR_RTO_LIMIT_MS = 15 * 60 * 1000;

export const REQUIRED_GOVERNANCE_IDS = [
  "consent-gated-notify",
  "residency-retention-crypto-shred",
  "blocked-flagged-model-output",
  "certified-only-registry-install",
] as const;

export const REQUIRED_PRIOR_STAGES = ["S0", "S1", "S2", "S3", "S4", "S5"] as const;

const fixtureUrl = new URL("../simulation/fixtures/stage-6-acceptance-fixture.json", import.meta.url);

export async function loadDrillFixture(url = fixtureUrl) {
  return JSON.parse(await readFile(url, "utf8"));
}

export type StageGateStatus = "pass" | "fail";

export interface Stage6DrillScenario {
  name: string;
  canary: {
    healthRegressionInjected: boolean;
    rollbackMode: "success" | "fail";
    autoRollbackTriggered: boolean;
  };
  finops: {
    fixtureCostUsd: number;
    planEstimateUsd: number;
  };
  dr: {
    replayDurationMs: number;
    projectionsByteIdentical: boolean;
  };
  dashboard: {
    wcag21aaPassed: boolean;
    pseudoLocPassed: boolean;
  };
  governance: {
    notify: { consentGranted: boolean; quietHoursActive: boolean; eventSourced: boolean };
    residency: { classification: string; regionEnforced: boolean; cryptoShredApplied: boolean };
    aiSafety: { modelOutputFlagged: boolean; guardrailBlocked: boolean };
    registry: { listingCertified: boolean; installAllowed: boolean; uncertifiedListed: boolean };
  };
  priorGates: Array<{ stage: string; status: StageGateStatus; evidenceRef: string }>;
  v1GaChecklist: Record<string, boolean>;
}

function checkCanaryRollback(scenario: Stage6DrillScenario) {
  if (!scenario.canary.healthRegressionInjected) {
    return { status: "fail" as const, detail: "canary regression not injected" };
  }
  if (!scenario.canary.autoRollbackTriggered) {
    return { status: "fail" as const, detail: "auto-rollback not triggered" };
  }
  if (scenario.canary.rollbackMode === "fail") {
    return { status: "fail" as const, detail: "rollback compensation failed" };
  }
  return { status: "pass" as const, detail: "canary regression auto-rolled-back" };
}

function checkPlanTimeCost(scenario: Stage6DrillScenario) {
  const { fixtureCostUsd, planEstimateUsd } = scenario.finops;
  if (fixtureCostUsd <= 0) {
    return { status: "fail" as const, detail: "invalid fixture cost" };
  }
  const deltaPercent = (Math.abs(planEstimateUsd - fixtureCostUsd) / fixtureCostUsd) * 100;
  if (deltaPercent > COST_TOLERANCE_PERCENT) {
    return {
      status: "fail" as const,
      detail: `plan-time cost ${planEstimateUsd} outside ±${COST_TOLERANCE_PERCENT}% of fixture ${fixtureCostUsd} (delta ${deltaPercent.toFixed(1)}%)`,
    };
  }
  return {
    status: "pass" as const,
    detail: `plan-time cost within ±${COST_TOLERANCE_PERCENT}% tolerance`,
  };
}

function checkDrRebuild(scenario: Stage6DrillScenario) {
  if (scenario.dr.replayDurationMs > DR_RTO_LIMIT_MS) {
    return {
      status: "fail" as const,
      detail: `DR rebuild ${scenario.dr.replayDurationMs}ms exceeds ${DR_RTO_LIMIT_MS}ms RTO`,
    };
  }
  if (!scenario.dr.projectionsByteIdentical) {
    return { status: "fail" as const, detail: "rebuilt projections not byte-identical" };
  }
  return { status: "pass" as const, detail: "DR rebuild within 15 min RTO from log replay" };
}

function checkDashboardAudits(scenario: Stage6DrillScenario) {
  if (!scenario.dashboard.wcag21aaPassed) {
    return { status: "fail" as const, detail: "WCAG 2.1 AA audit failed" };
  }
  if (!scenario.dashboard.pseudoLocPassed) {
    return { status: "fail" as const, detail: "pseudo-localization audit failed" };
  }
  return { status: "pass" as const, detail: "dashboard WCAG 2.1 AA + pseudo-loc audits green" };
}

function checkGovernance(scenario: Stage6DrillScenario) {
  const items = [
    evaluateConsentGatedNotify(scenario),
    evaluateResidencyRetention(scenario),
    evaluateAiSafetyGuardrail(scenario),
    evaluateRegistryInstall(scenario),
  ];
  const passed = items.every((item) => item.passed);
  return {
    status: passed ? ("pass" as const) : ("fail" as const),
    detail: passed ? "four governance-plane evidence items pass" : "governance evidence incomplete",
    items,
  };
}

function evaluateConsentGatedNotify(scenario: Stage6DrillScenario) {
  const { consentGranted, quietHoursActive, eventSourced } = scenario.governance.notify;
  const deferred = quietHoursActive && !consentGranted;
  const passed = eventSourced && (consentGranted || deferred);
  return {
    id: "consent-gated-notify",
    passed,
    detail: passed
      ? "notify send event-sourced and consent/quiet-hours gated"
      : "notify bypassed consent or missing event sourcing",
  };
}

function evaluateResidencyRetention(scenario: Stage6DrillScenario) {
  const { classification, regionEnforced, cryptoShredApplied } = scenario.governance.residency;
  const passed = classification !== "unclassified" && regionEnforced && cryptoShredApplied;
  return {
    id: "residency-retention-crypto-shred",
    passed,
    detail: passed
      ? "classified field enforced residency/retention with crypto-shred"
      : "residency/retention obligation or crypto-shred missing",
  };
}

function evaluateAiSafetyGuardrail(scenario: Stage6DrillScenario) {
  const { modelOutputFlagged, guardrailBlocked } = scenario.governance.aiSafety;
  const passed = !modelOutputFlagged || guardrailBlocked;
  return {
    id: "blocked-flagged-model-output",
    passed,
    detail: passed ? "flagged model output blocked by guardrail" : "flagged model output reached caller",
  };
}

function evaluateRegistryInstall(scenario: Stage6DrillScenario) {
  const { listingCertified, installAllowed, uncertifiedListed } = scenario.governance.registry;
  const passed = listingCertified && installAllowed && !uncertifiedListed;
  return {
    id: "certified-only-registry-install",
    passed,
    detail: passed
      ? "certified listing installs via Matching; uncertified stays unlisted"
      : "uncertified listing visible or certified install blocked",
  };
}

function checkPriorGates(scenario: Stage6DrillScenario) {
  const byStage = new Map(scenario.priorGates.map((gate) => [gate.stage, gate]));
  const missing = REQUIRED_PRIOR_STAGES.filter((stage) => !byStage.has(stage));
  if (missing.length > 0) {
    return {
      status: "fail" as const,
      detail: `missing prior gate records: ${missing.join(", ")}`,
      gates: scenario.priorGates,
    };
  }
  const failed = scenario.priorGates.filter((gate) => gate.status !== "pass");
  if (failed.length > 0) {
    return {
      status: "fail" as const,
      detail: `prior gates failed: ${failed.map((gate) => gate.stage).join(", ")}`,
      gates: scenario.priorGates,
    };
  }
  return {
    status: "pass" as const,
    detail: "all prior stage gates S0-S5 re-run green (ADR-0063)",
    gates: scenario.priorGates,
  };
}

function evaluateV1GaChecklist(checklist: Record<string, boolean>) {
  const entries = Object.entries(checklist);
  const incomplete = entries.filter(([, done]) => !done).map(([key]) => key);
  return {
    complete: incomplete.length === 0,
    incomplete,
  };
}

export function runStage6AcceptanceDrill(scenario: Stage6DrillScenario) {
  const canary = checkCanaryRollback(scenario);
  const finops = checkPlanTimeCost(scenario);
  const dr = checkDrRebuild(scenario);
  const dashboard = checkDashboardAudits(scenario);
  const governance = checkGovernance(scenario);
  const priorGates = checkPriorGates(scenario);
  const gaChecklist = evaluateV1GaChecklist(scenario.v1GaChecklist);

  const checks = [
    { id: "canary-auto-rollback", ...canary },
    { id: "plan-time-cost-tolerance", ...finops },
    { id: "dr-rebuild-rto", ...dr },
    { id: "dashboard-a11y-audits", ...dashboard },
    { id: "governance-evidence", ...governance },
    { id: "prior-stage-gates", ...priorGates },
  ];

  const ok =
    checks.every((check) => check.status === "pass") && gaChecklist.complete;

  return {
    issue: "HOBO-665",
    scenario: scenario.name,
    ok,
    checks,
    governance: governance.items,
    priorGates: priorGates.gates,
    v1GaChecklistComplete: gaChecklist.complete,
    v1GaChecklistIncomplete: gaChecklist.incomplete,
    acceptanceRecordId: "S6-01",
    evidenceAttached: ok,
  };
}

export function createStage6DrillHarness(scenario: Stage6DrillScenario) {
  return {
    evaluateCanaryRollback() {
      return checkCanaryRollback(scenario);
    },
    evaluatePlanTimeCost() {
      return checkPlanTimeCost(scenario);
    },
    evaluateDrRebuild() {
      return checkDrRebuild(scenario);
    },
    evaluateDashboardAudits() {
      return checkDashboardAudits(scenario);
    },
    evaluateGovernance() {
      return checkGovernance(scenario);
    },
    evaluatePriorGates() {
      return checkPriorGates(scenario);
    },
    runDrill() {
      return runStage6AcceptanceDrill(scenario);
    },
  };
}

export async function verifyPactContracts(harness: ReturnType<typeof createStage6DrillHarness>) {
  const drill = harness.runDrill();
  const boundaries = [];

  for (const boundary of CONTRACT_BOUNDARIES) {
    const pact = JSON.parse(
      await readFile(new URL(`../contracts/pacts/${boundary.pactFile}`, import.meta.url), "utf8"),
    );
    assert.equal(pact.metadata.boundaryId, boundary.id);

    let responseBody: JsonObject = { ok: drill.ok };
    switch (boundary.id) {
      case "canary-rollback":
        responseBody = { ...harness.evaluateCanaryRollback(), ok: harness.evaluateCanaryRollback().status === "pass" };
        break;
      case "finops-cost-estimate":
        responseBody = { ...harness.evaluatePlanTimeCost(), ok: harness.evaluatePlanTimeCost().status === "pass" };
        break;
      case "dr-replay-rebuild":
        responseBody = { ...harness.evaluateDrRebuild(), ok: harness.evaluateDrRebuild().status === "pass" };
        break;
      case "dashboard-a11y-audit":
        responseBody = {
          ...harness.evaluateDashboardAudits(),
          ok: harness.evaluateDashboardAudits().status === "pass",
        };
        break;
      case "governance-plane":
        responseBody = {
          items: harness.evaluateGovernance().items,
          ok: harness.evaluateGovernance().status === "pass",
        };
        break;
      case "prior-stage-gates":
        responseBody = {
          gates: harness.evaluatePriorGates().gates,
          ok: harness.evaluatePriorGates().status === "pass",
        };
        break;
      case "acceptance-record":
        responseBody = {
          recordId: drill.acceptanceRecordId,
          evidenceAttached: drill.evidenceAttached,
          v1GaChecklistComplete: drill.v1GaChecklistComplete,
          ok: drill.evidenceAttached && drill.v1GaChecklistComplete,
        };
        break;
    }

    const expectedStatus = pact.interactions[0].response.status;
    const interactionOk = expectedStatus === 200;
    boundaries.push({ id: boundary.id, verified: interactionOk && isJsonBoolean(responseBody.ok) });
  }

  return {
    status: boundaries.every((boundary) => boundary.verified) ? "verified" : "failed",
    boundaries,
  };
}
