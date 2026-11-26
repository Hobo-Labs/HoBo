import assert from "node:assert/strict";
import { test } from "vitest";

import { createGoldenSlo } from "../../slo-as-code-contract/src/slo-contract.js";
import {
  SLO_GAMING_GUARD_CONTRACT_VERSION,
  assessSloDefinitionChange,
  evaluateAvailabilityGap,
  evaluateSliCoverage,
} from "../src/slo-gaming-guard-contract.js";

const NOW = "2026-06-27T19:30:00.000Z";

test("contract exports a versioned SLO anti-gaming surface", () => {
  assert.equal(SLO_GAMING_GUARD_CONTRACT_VERSION, "hobo.slo-gaming-guard/v1");
});

test("objective relaxation and window widening during burn require a policy gate and audit", () => {
  const decision = assessSloDefinitionChange({
    current: makeSlo({ target: 0.999, duration: "1h" }),
    proposed: makeSlo({ target: 0.99, duration: "30d", effectiveAt: NOW }),
    actor: {
      principal: "principal:platform-eng/alice",
      justification: "Incident INC-7 needs temporary threshold review",
    },
    context: {
      budgetState: "burning",
      burnRate: 2.4,
    },
    now: NOW,
  });

  assert.equal(decision.verdict, "requires-policy-approval");
  assert.deepEqual(decision.reasons, [
    "objective-relaxation-mid-burn",
    "window-widening-mid-burn",
  ]);
  assert.equal(decision.policyGate.dimension, "can-deploy");
  assert.equal(decision.auditEvent.type, "slo.DefinitionChangeAssessed");
  assert.equal(decision.auditEvent.actor, "principal:platform-eng/alice");
  assert.equal(decision.auditEvent.justification, "Incident INC-7 needs temporary threshold review");
  assert.deepEqual(decision.auditEvent.change.objectiveTarget, { from: 0.999, to: 0.99 });
  assert.deepEqual(decision.auditEvent.change.timeWindow, { from: "1h", to: "30d" });
});

test("secondary objective relaxation is gated and audited", () => {
  const decision = assessSloDefinitionChange({
    current: makeSlo({
      target: 0.999,
      duration: "1h",
      objectives: [
        { displayName: "availability", target: 0.999 },
        { displayName: "latency", target: 0.95 },
      ],
    }),
    proposed: makeSlo({
      target: 0.999,
      duration: "1h",
      objectives: [
        { displayName: "availability", target: 0.999 },
        { displayName: "latency", target: 0.9 },
      ],
      effectiveAt: NOW,
    }),
    actor: {
      principal: "principal:platform-eng/alice",
      justification: "Relax latency while checkout is burning",
    },
    context: {
      budgetState: "burning",
    },
    now: NOW,
  });

  assert.equal(decision.verdict, "requires-policy-approval");
  assert.deepEqual(decision.reasons, ["objective-relaxation-mid-burn"]);
  assert.deepEqual(decision.auditEvent.change.objectives.to, [
    { displayName: "availability", target: 0.999 },
    { displayName: "latency", target: 0.9 },
  ]);
});

test("SLI source and exclusion rule changes are policy visible and audited", () => {
  const decision = assessSloDefinitionChange({
    current: makeSlo({
      target: 0.999,
      duration: "1h",
      exclusionRules: [{ name: "planned-maintenance", reason: "maintenance", approvedBy: "policy" }],
    }),
    proposed: makeSlo({
      target: 0.999,
      duration: "1h",
      effectiveAt: NOW,
      indicator: {
        ratioMetric: {
          counter: true,
          good: {
            telemetry: {
              query: "sum(rate(http_requests_total{code=~'2..|3..', synthetic='true'}[5m]))",
              unit: "requests",
            },
          },
          total: {
            telemetry: {
              query: "sum(rate(http_requests_total{synthetic='true'}[5m]))",
              unit: "requests",
            },
          },
        },
      },
      exclusionRules: [
        { name: "planned-maintenance", reason: "maintenance", approvedBy: "policy" },
        { name: "ignore-5xx", reason: "drop-5xx-errors", approvedBy: "self" },
      ],
    }),
    actor: {
      principal: "principal:platform-eng/alice",
      justification: "Adjust SLI collection during incident INC-8",
    },
    context: {
      budgetState: "burning",
    },
    now: NOW,
  });

  assert.equal(decision.verdict, "requires-policy-approval");
  assert.deepEqual(decision.reasons, [
    "sli-source-change-mid-burn",
    "exclusion-rule-change-requires-policy",
  ]);
  assert.match(decision.auditEvent.change.sliSource.to.ratioMetric.good.telemetry.query, /synthetic='true'/);
  assert.equal(decision.auditEvent.change.exclusionRules.to[1].reason, "drop-5xx-errors");
});

test("SLO definition changes without principal and justification are denied", () => {
  const decision = assessSloDefinitionChange({
    current: makeSlo({ target: 0.999, duration: "1h" }),
    proposed: makeSlo({ target: 0.999, duration: "1h", effectiveAt: NOW }),
    actor: {
      principal: "principal:platform-eng/alice",
    },
    now: NOW,
  });

  assert.equal(decision.verdict, "deny");
  assert.deepEqual(decision.reasons, ["missing-change-justification"]);
  assert.equal(decision.auditEvent, null);
});

test("coverage check flags SLIs that exclude served failing traffic but accepts planned maintenance", () => {
  const checked = evaluateSliCoverage({
    servedRequestCount: 1000,
    countedRequestCount: 800,
    exclusions: [
      {
        reason: "planned-maintenance",
        count: 100,
        approved: true,
        incidentId: "INC-100",
      },
      {
        reason: "drop-5xx-errors",
        count: 100,
      },
    ],
    minAccountableCoverageRatio: 0.95,
  });

  assert.equal(checked.status, "gaming-signal");
  assert.equal(checked.accountableCoverageRatio, 0.9);
  assert.deepEqual(checked.signals, [
    "sli-excludes-failing-traffic",
    "served-traffic-coverage-below-threshold",
  ]);

  const plannedMaintenance = evaluateSliCoverage({
    servedRequestCount: 1000,
    countedRequestCount: 900,
    exclusions: [
      {
        reason: "planned-maintenance",
        count: 100,
        approved: true,
        incidentId: "INC-101",
      },
    ],
    minAccountableCoverageRatio: 0.95,
  });

  assert.equal(plannedMaintenance.status, "ok");
  assert.equal(plannedMaintenance.accountableCoverageRatio, 1);
});

test("architecture estimate versus observed availability gap raises a quality signal", () => {
  const signal = evaluateAvailabilityGap({
    estimatedAvailability: 0.999,
    observedAvailability: 0.94,
    maxAllowedGap: 0.02,
  });

  assert.equal(signal.status, "gaming-signal");
  assert.equal(signal.gap, 0.059);
  assert.deepEqual(signal.signals, ["availability-estimate-observed-gap"]);
});

test("iterative objective nudging just below a freeze threshold is detected", () => {
  const decision = assessSloDefinitionChange({
    current: makeSlo({ target: 0.996, duration: "1h" }),
    proposed: makeSlo({ target: 0.995, duration: "1h", effectiveAt: NOW }),
    actor: {
      principal: "agent:sre-auto",
      justification: "Need deploy unblocked",
    },
    context: {
      budgetState: "burning",
      freezeRemainingBudgetRatio: 0.2,
      remainingBudgetRatio: 0.19,
    },
    history: [
      change("2026-06-27T19:00:00.000Z", 0.999, 0.998, "agent:sre-auto"),
      change("2026-06-27T19:10:00.000Z", 0.998, 0.996, "agent:sre-auto"),
    ],
    now: NOW,
  });

  assert.equal(decision.verdict, "requires-policy-approval");
  assert.deepEqual(decision.gamingSignals, ["iterative-objective-relaxation-near-freeze"]);
});

test("backdated effective times fail closed", () => {
  const decision = assessSloDefinitionChange({
    current: makeSlo({ target: 0.999, duration: "1h" }),
    proposed: makeSlo({ target: 0.999, duration: "1h", effectiveAt: "2026-06-27T18:00:00.000Z" }),
    actor: {
      principal: "principal:platform-eng/alice",
      justification: "retroactive cleanup",
    },
    now: NOW,
  });

  assert.equal(decision.verdict, "deny");
  assert.deepEqual(decision.reasons, ["backdated-slo-change"]);
  assert.deepEqual(decision.auditEvent.reasons, ["backdated-slo-change"]);
});

test("synthetic-only SLIs with real-user failures are flagged", () => {
  const checked = evaluateSliCoverage({
    servedRequestCount: 500,
    countedRequestCount: 500,
    sourceKind: "synthetic",
    realUserFailureCount: 25,
  });

  assert.equal(checked.status, "gaming-signal");
  assert.deepEqual(checked.signals, ["synthetic-only-sli-ignores-real-user-failures"]);
});

test("relaxing an SLO and reverting after deploy lands remains visible as a gaming signal", () => {
  const decision = assessSloDefinitionChange({
    current: makeSlo({ target: 0.99, duration: "30d" }),
    proposed: makeSlo({ target: 0.999, duration: "1h", effectiveAt: NOW }),
    actor: {
      principal: "principal:platform-eng/alice",
      justification: "restore after deploy",
    },
    context: {
      deploymentLandedAt: "2026-06-27T19:20:00.000Z",
    },
    history: [
      {
        at: "2026-06-27T19:05:00.000Z",
        actor: "principal:platform-eng/alice",
        objectiveTarget: { from: 0.999, to: 0.99 },
        timeWindow: { from: "1h", to: "30d" },
        reasons: ["objective-relaxation-mid-burn", "window-widening-mid-burn"],
      },
    ],
    now: NOW,
  });

  assert.equal(decision.verdict, "allow");
  assert.deepEqual(decision.gamingSignals, ["post-deploy-revert-after-slo-relaxation"]);
  assert.equal(decision.auditEvent.change.objectiveTarget.to, 0.999);
});

function makeSlo({
  target,
  duration,
  effectiveAt = "2026-06-27T19:30:00.000Z",
  objectives,
  indicator,
  exclusionRules,
}) {
  const spec = {
    timeWindow: {
      duration,
      isRolling: true,
    },
    objectives: [
      {
        displayName: "availability",
        target,
      },
    ],
  };
  if (objectives) spec.objectives = objectives;
  if (indicator) spec.indicator = indicator;
  if (exclusionRules) spec.exclusionRules = exclusionRules;

  return createGoldenSlo({
    metadata: {
      name: "checkout-availability",
      annotations: {
        "hobo.dev/effectiveAt": effectiveAt,
      },
    },
    spec,
  });
}

function change(at, from, to, actor) {
  return {
    at,
    actor,
    objectiveTarget: { from, to },
    reasons: ["objective-relaxation-mid-burn"],
  };
}
