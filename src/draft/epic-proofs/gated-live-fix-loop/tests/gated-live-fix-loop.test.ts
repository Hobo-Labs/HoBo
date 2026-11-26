import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  replayGatedLiveFixLoop,
  runGatedLiveFixLoop,
} from "../services/gated-live-fix-loop.js";

describe("gated live-fix loop (HOBO-654)", () => {
  it("drives a low-risk fix through canary and auto-rolls back when canary SLO regresses", () => {
    const result = runGatedLiveFixLoop(
      scenario({
        environment: "staging",
        canaryObservation: canaryRegression(),
      }),
    );

    assert.equal(result.status, "rolled-back");
    assert.equal(result.applied, false);
    assert.equal(result.canaryGate.outcome, "regression");
    assert.equal(result.regressionTests[0].sourceTraceId, "trace-checkout-500");
    assert.equal(result.regressionTests[0].permanent, true);

    const eventTypes = result.events.map((event) => event.type);
    assert.ok(eventTypes.includes("slo.RegressionDetected"));
    assert.ok(eventTypes.includes("gen.CandidateGenerated"));
    assert.ok(eventTypes.includes("gen.ValidationRequested"));
    assert.ok(eventTypes.includes("gen.ValidationPassed"));
    assert.ok(eventTypes.includes("policy.Decided"));
    assert.ok(eventTypes.includes("deployment.CanaryStarted"));
    assert.ok(eventTypes.includes("deployment.RolledBack"));
    assert.ok(eventTypes.includes("livefix.RegressionTestRetained"));

    const replay = replayGatedLiveFixLoop(result.events);
    assert.equal(replay.status, "rolled-back");
    assert.equal(replay.sloRegressionDetected, true);
    assert.equal(replay.candidateGenerated, true);
    assert.equal(replay.retainedRegressionTests[0].id, "regression:trace-checkout-500");
  });

  it("blocks a production-classified fix until human approval", () => {
    const result = runGatedLiveFixLoop(
      scenario({
        environment: "prod",
        canaryObservation: canaryHealthy(),
      }),
    );

    assert.equal(result.status, "needs-approval");
    assert.equal(result.needsApproval, true);
    assert.equal(result.approvalRequest.reason, "production-or-high-risk-live-fix");
    assert.ok(!result.events.some((event) => event.type === "deployment.CanaryStarted"));
    assert.equal(result.regressionTests[0].permanent, true);

    const replay = replayGatedLiveFixLoop(result.events);
    assert.equal(replay.needsApproval, true);
    assert.equal(replay.policyEffect, "require-approval");
  });

  it("promotes a low-risk fix when canary observation stays healthy", () => {
    const result = runGatedLiveFixLoop(
      scenario({
        environment: "staging",
        canaryObservation: canaryHealthy(),
      }),
    );

    assert.equal(result.status, "applied");
    assert.equal(result.applied, true);
    assert.equal(result.canaryGate.outcome, "healthy");
    assert.ok(result.events.some((event) => event.type === "deployment.Promoted"));
    assert.equal(result.regressionTests[0].permanent, true);
  });

  it("adversarial: rejects candidate that regresses the captured failing trace replay", () => {
    const result = runGatedLiveFixLoop(
      scenario({
        candidate: {
          traceReplay: { passed: false, reportRef: "validation://trace/replay-failed" },
        },
      }),
    );

    assert.equal(result.status, "blocked-by-validation");
    assert.equal(result.reason, "failing-trace-replay-regressed");
    assert.ok(!result.events.some((event) => event.type === "deployment.CanaryStarted"));
    assert.equal(result.regressionTests[0].permanent, true);
  });

  it("adversarial: forces approval for destructive live-fix candidates", () => {
    const result = runGatedLiveFixLoop(
      scenario({
        environment: "staging",
        candidate: { blastRadius: { destructive: true } },
        canaryObservation: canaryHealthy(),
      }),
    );

    assert.equal(result.status, "needs-approval");
    assert.equal(result.reason, "destructive-live-fix");
    assert.ok(!result.events.some((event) => event.type === "deployment.CanaryStarted"));
  });

  it("adversarial: honors maxBlastRadius before canarying the generated fix", () => {
    const result = runGatedLiveFixLoop(
      scenario({
        environment: "staging",
        policy: { maxBlastRadius: { maxResources: 1 } },
        candidate: { blastRadius: { maxResources: 3 } },
        canaryObservation: canaryHealthy(),
      }),
    );

    assert.equal(result.status, "needs-approval");
    assert.equal(result.reason, "max-blast-radius-exceeded");
    assert.ok(!result.events.some((event) => event.type === "deployment.CanaryStarted"));
  });

  it("architecture artifacts pin protobuf, CUE, Pact, and ADR boundaries", () => {
    const adr = readFileSync(new URL("../ADR.md", import.meta.url), "utf8");
    const proto = readFileSync(
      new URL("../architecture/gated_live_fix_loop.proto", import.meta.url),
      "utf8",
    );
    const cue = readFileSync(
      new URL("../architecture/gated_live_fix_loop.cue", import.meta.url),
      "utf8",
    );
    const pact = JSON.parse(
      readFileSync(
        new URL("../architecture/pacts/gated_live_fix_loop.pact.json", import.meta.url),
        "utf8",
      ),
    );

    assert.match(proto, /message GatedLiveFixLoopRecord/);
    assert.match(cue, /#GatedLiveFixLoopRecord:/);
    assert.equal(pact.consumer.name, "GatedLiveFixLoopConsumer");
    assert.equal(pact.provider.name, "GatedLiveFixLoopBoundary");
    assert.equal(pact.interactions[0].response.body.ok, true);
    assert.match(adr, /parse, don't validate/i);
    assert.match(adr, /Command/i);
    assert.match(adr, /Event/i);
    assert.match(adr, /Actor/i);
    assert.match(adr, /event store/i);
    assert.match(adr, /projection/i);
    assert.match(adr, /read store/i);
  });
});

function scenario(overrides = {}) {
  return {
    now: "2026-07-02T00:10:00.000Z",
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
      hypothesis: "increase connection pool timeout",
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
      ...overrides.rollout,
    },
    sloRegression: overrides.sloRegression ?? {
      snapshot: {
        sloId: "checkout-availability",
        seq: 22,
        status: "available",
        burnRate: 14.8,
        remainingBudgetRatio: 0.04,
      },
      windowSamples: [
        { seq: 21, status: "available", burnRate: 13.5, remainingBudgetRatio: 0.06 },
        { seq: 22, status: "available", burnRate: 14.8, remainingBudgetRatio: 0.04 },
      ],
    },
    canaryObservation: overrides.canaryObservation ?? canaryRegression(),
  };
}

function canaryRegression() {
  return {
    snapshot: {
      sloId: "checkout-availability",
      seq: 24,
      status: "available",
      burnRate: 15.2,
      remainingBudgetRatio: 0.03,
    },
    windowSamples: [
      { seq: 23, status: "available", burnRate: 14.1, remainingBudgetRatio: 0.05 },
      { seq: 24, status: "available", burnRate: 15.2, remainingBudgetRatio: 0.03 },
    ],
    goldenSuite: { suiteId: "checkout-golden", status: "passed", failures: [] },
  };
}

function canaryHealthy() {
  return {
    snapshot: {
      sloId: "checkout-availability",
      seq: 26,
      status: "available",
      burnRate: 0.3,
      remainingBudgetRatio: 0.85,
    },
    windowSamples: [
      { seq: 25, status: "available", burnRate: 0.4, remainingBudgetRatio: 0.84 },
      { seq: 26, status: "available", burnRate: 0.3, remainingBudgetRatio: 0.85 },
    ],
    goldenSuite: { suiteId: "checkout-golden", status: "passed", failures: [] },
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
