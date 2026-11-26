import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  planLiveFixCandidate,
  replayLiveFixEvents,
} from "../src/live-fix-gated-candidate.js";

describe("live-fix gated candidate contract", () => {
  it("drives a low-risk failing trace through canary and auto-rolls back on regression", () => {
    const result = planLiveFixCandidate(
      scenario({
        environment: "staging",
        rollout: { canaryOutcome: "regression", failedGate: "golden-suite-regressed" },
      }),
    );

    assert.equal(result.status, "rolled-back");
    assert.equal(result.applied, false);
    assert.equal(result.rollback.reversible, true);
    assert.ok(result.events.some((event) => event.type === "deployment.CanaryStarted"));
    assert.ok(result.events.some((event) => event.type === "deployment.RolledBack"));
    assert.equal(result.regressionTests[0].sourceTraceId, "trace-checkout-500");
    assert.equal(result.regressionTests[0].permanent, true);

    const replay = replayLiveFixEvents(result.events);
    assert.equal(replay.status, "rolled-back");
    assert.equal(replay.policyEffect, "allow-canary");
    assert.equal(replay.retainedRegressionTests[0].id, "regression:trace-checkout-500");
  });

  it("escalates a production live-fix candidate to human approval", () => {
    const result = planLiveFixCandidate(scenario({ environment: "prod" }));

    assert.equal(result.status, "needs-approval");
    assert.equal(result.needsApproval, true);
    assert.equal(result.approvalRequest.kind, "human");
    assert.equal(result.approvalRequest.reason, "production-or-high-risk-live-fix");
    assert.ok(!result.events.some((event) => event.type === "deployment.CanaryStarted"));
    assert.equal(replayLiveFixEvents(result.events).needsApproval, true);
  });

  it("does not apply a candidate that regresses the captured failing trace replay", () => {
    const result = planLiveFixCandidate(
      scenario({
        candidate: { traceReplay: { passed: false, reportRef: "validation://trace/replay-failed" } },
      }),
    );

    assert.equal(result.status, "blocked-by-validation");
    assert.equal(result.reason, "failing-trace-replay-regressed");
    assert.ok(!result.events.some((event) => event.type === "policy.Decided"));
    assert.ok(!result.events.some((event) => event.type.startsWith("deployment.")));
    assert.equal(result.regressionTests[0].permanent, true);
  });

  it("honors maxBlastRadius before canarying the generated fix", () => {
    const result = planLiveFixCandidate(
      scenario({
        environment: "staging",
        policy: { maxBlastRadius: { maxResources: 1 } },
        candidate: { blastRadius: { maxResources: 3 } },
      }),
    );

    assert.equal(result.status, "needs-approval");
    assert.equal(result.reason, "max-blast-radius-exceeded");
    assert.ok(!result.events.some((event) => event.type === "deployment.CanaryStarted"));
    assert.equal(replayLiveFixEvents(result.events).policyEffect, "require-approval");
  });

  it("forces human approval for destructive live-fix candidates", () => {
    const result = planLiveFixCandidate(
      scenario({
        environment: "staging",
        candidate: { blastRadius: { destructive: true } },
      }),
    );

    assert.equal(result.status, "needs-approval");
    assert.equal(result.reason, "destructive-live-fix");
    assert.ok(!result.events.some((event) => event.type === "deployment.CanaryStarted"));
  });
});

function scenario(overrides = {}) {
  return {
    now: "2026-06-28T07:35:00.000Z",
    incident: {
      id: "incident-checkout-500",
      correlationId: "corr-checkout-500",
      environment: overrides.environment ?? "staging",
      signal: "slo-burn",
      failureEventId: "slo-burn-checkout",
    },
    failingTrace: {
      id: "trace-checkout-500",
      assertions: [
        "checkout POST /orders returns 2xx",
        "payment authorization span completes before response",
      ],
    },
    candidate: mergeCandidate({
      id: "candidate-live-fix-001",
      patchRef: "draft://generated-stack/live-fix/candidate-001",
      riskClass: "low",
      sandbox: { passed: true, reportRef: "validation://sandbox/green" },
      conformance: { passed: true, reportRef: "validation://conformance/green" },
      traceReplay: { passed: true, reportRef: "validation://trace/replay-green" },
      blastRadius: {
        maxResources: 1,
        destructive: false,
        reversible: true,
        compensationRef: "rollback://candidate-live-fix-001",
      },
    }, overrides.candidate),
    policy: overrides.policy ?? { maxBlastRadius: { maxResources: 1 } },
    rollout: {
      id: "rollout-live-fix-001",
      canaryOutcome: "healthy",
      failedGate: "slo-burn",
      autoRollbackSignals: ["slo-burn", "golden-suite"],
      ...overrides.rollout,
    },
  };
}

function mergeCandidate(base, patch = {}) {
  return {
    ...base,
    ...patch,
    sandbox: { ...base.sandbox, ...patch.sandbox },
    conformance: { ...base.conformance, ...patch.conformance },
    traceReplay: { ...base.traceReplay, ...patch.traceReplay },
    blastRadius: { ...base.blastRadius, ...patch.blastRadius },
  };
}
