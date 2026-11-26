import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { foldCrewStream } from "../../crew-event-contract/src/crew-event-contract.js";
import {
  evaluateRemediationSafety,
  replayRemediationSafety,
} from "../src/remediation-safety-gate.js";

describe("remediation safety gate contract", () => {
  it("escalates a single uncorroborated destructive signal without applying remediation", () => {
    const result = evaluateRemediationSafety({
      signal: signal({ id: "alert-prod-cost-1", source: "slo-monitor" }),
      action: haltSpendAction(),
      operator: sreOperator(),
      rbac: rbac({ grants: ["remediation:apply"] }),
      costEstimateUsd: 5,
      spendLedger: { currentUsd: 10, capUsd: 50, scopeKey: "camp:payments-prod", windowId: "2026-06" },
      decidedAt: "2026-06-28T02:30:00.000Z",
    });

    assert.equal(result.status, "escalated");
    assert.equal(result.decision.reason, "uncorroborated-destructive-signal");
    assert.equal(result.policyDecision.data.effect, "require-approval");
    assert.deepEqual(
      result.events.crew.map((event) => event.type),
      ["policy.Decided", "crew.ActionProposed", "crew.ActionDenied", "crew.HandoffRequested"],
    );
    assert.ok(!result.events.crew.some((event) => event.type === "crew.ActionApplied"));
    assert.equal(foldCrewStream(result.events.crew).handoffs.length, 1);
  });

  it("denies a remediation action that exceeds the operator role", () => {
    const result = evaluateRemediationSafety({
      signal: signal({ id: "queue-depth-api-1" }),
      corroboratingSignals: [signal({ id: "queue-depth-api-1-metrics", source: "metrics" })],
      action: scaleAction(),
      operator: sreOperator(),
      rbac: rbac({ grants: ["remediation:propose"] }),
      costEstimateUsd: 3,
      spendLedger: { currentUsd: 10, capUsd: 50, scopeKey: "camp:staging", windowId: "2026-06" },
      decidedAt: "2026-06-28T02:31:00.000Z",
    });

    assert.equal(result.status, "denied");
    assert.equal(result.decision.reason, "rbac-role-missing-remediation-apply");
    assert.equal(result.policyDecision.data.effect, "deny");
    assert.equal(result.denied.data.reason, "rbac-role-missing-remediation-apply");
    assert.ok(!result.events.crew.some((event) => event.type === "crew.ActionApplied"));
  });

  it("denies an over-spend-cap remediation before apply", () => {
    const result = evaluateRemediationSafety({
      signal: signal({ id: "queue-depth-api-2" }),
      corroboratingSignals: [signal({ id: "queue-depth-api-2-metrics", source: "metrics" })],
      action: scaleAction(),
      operator: sreOperator({ spendCapUsd: 20 }),
      rbac: rbac({ grants: ["remediation:apply"] }),
      costEstimateUsd: 12,
      spendLedger: { currentUsd: 10, capUsd: 20, scopeKey: "camp:staging", windowId: "2026-06" },
      decidedAt: "2026-06-28T02:32:00.000Z",
    });

    assert.equal(result.status, "denied");
    assert.equal(result.decision.reason, "spend-cap-exceeded");
    assert.equal(result.decision.projectedSpendUsd, 22);
    assert.equal(result.denied.data.reason, "spend-cap-exceeded");
    assert.ok(!result.events.crew.some((event) => event.type === "crew.ActionApplied"));
  });

  it("rejects forged and replayed signals without applying remediation", () => {
    const forged = evaluateRemediationSafety({
      signal: signal({
        id: "forged-alert-1",
        source: "unknown-webhook",
        provenance: { issuer: "webhook:external", signature: "invalid" },
      }),
      action: scaleAction(),
      operator: sreOperator(),
      rbac: rbac({ grants: ["remediation:apply"] }),
      costEstimateUsd: 1,
      spendLedger: { currentUsd: 1, capUsd: 20, scopeKey: "camp:staging", windowId: "2026-06" },
      decidedAt: "2026-06-28T02:33:00.000Z",
    });

    assert.equal(forged.status, "denied");
    assert.equal(forged.decision.reason, "signal-provenance-invalid");
    assert.ok(!forged.events.crew.some((event) => event.type === "crew.ActionApplied"));

    const first = evaluateRemediationSafety({
      signal: signal({ id: "queue-depth-api-3" }),
      corroboratingSignals: [signal({ id: "queue-depth-api-3-metrics", source: "metrics" })],
      action: scaleAction({ idempotencyKey: "scale-api-3" }),
      operator: sreOperator(),
      rbac: rbac({ grants: ["remediation:apply"] }),
      costEstimateUsd: 1,
      spendLedger: { currentUsd: 1, capUsd: 20, scopeKey: "camp:staging", windowId: "2026-06" },
      decidedAt: "2026-06-28T02:34:00.000Z",
    });
    const replayed = evaluateRemediationSafety({
      priorEvents: first.events,
      signal: signal({ id: "queue-depth-api-3" }),
      corroboratingSignals: [signal({ id: "queue-depth-api-3-metrics-2", source: "metrics" })],
      action: scaleAction({ idempotencyKey: "scale-api-3-replay" }),
      operator: sreOperator(),
      rbac: rbac({ grants: ["remediation:apply"] }),
      costEstimateUsd: 1,
      spendLedger: { currentUsd: 1, capUsd: 20, scopeKey: "camp:staging", windowId: "2026-06" },
      decidedAt: "2026-06-28T02:35:00.000Z",
    });

    assert.equal(first.status, "allowed");
    assert.equal(replayed.status, "denied");
    assert.equal(replayed.decision.reason, "signal-replay-detected");
    assert.ok(!replayed.events.crew.some((event) => event.type === "crew.ActionApplied"));

    const idempotencyReplay = evaluateRemediationSafety({
      priorEvents: first.events,
      signal: signal({ id: "queue-depth-api-3-new-signal" }),
      corroboratingSignals: [signal({ id: "queue-depth-api-3-new-signal-metrics", source: "metrics" })],
      action: scaleAction({ idempotencyKey: "scale-api-3" }),
      operator: sreOperator(),
      rbac: rbac({ grants: ["remediation:apply"] }),
      costEstimateUsd: 1,
      spendLedger: { currentUsd: 1, capUsd: 20, scopeKey: "camp:staging", windowId: "2026-06" },
      decidedAt: "2026-06-28T02:35:30.000Z",
    });

    assert.equal(idempotencyReplay.status, "denied");
    assert.equal(idempotencyReplay.decision.reason, "action-idempotency-replay-detected");
    assert.ok(!idempotencyReplay.events.crew.some((event) => event.type === "crew.ActionApplied"));
  });

  it("does not let an operator widen its own allow list to authorize remediation", () => {
    const result = evaluateRemediationSafety({
      signal: signal({ id: "queue-depth-api-4" }),
      corroboratingSignals: [signal({ id: "queue-depth-api-4-metrics", source: "metrics" })],
      action: scaleAction(),
      operator: sreOperator({ scopedCapabilities: ["incident:read", "remediation:propose"] }),
      attemptedAllow: {
        actorId: "spiffe://yard/acme/agent/sre",
        scopedCapabilities: ["incident:read", "remediation:propose", "remediation:apply"],
      },
      rbac: rbac({ grants: ["remediation:apply"] }),
      costEstimateUsd: 1,
      spendLedger: { currentUsd: 1, capUsd: 20, scopeKey: "camp:staging", windowId: "2026-06" },
      decidedAt: "2026-06-28T02:36:00.000Z",
    });

    assert.equal(result.status, "denied");
    assert.equal(result.decision.reason, "self-authorized-capability-widening");
    assert.equal(result.denied.data.reason, "self-authorized-capability-widening");
    assert.ok(!result.events.crew.some((event) => event.type === "crew.ActionApplied"));
  });

  it("aggregates near-cap split remediations so sub-cap actions cannot bypass spend policy", () => {
    const first = evaluateRemediationSafety({
      signal: signal({ id: "queue-depth-api-5" }),
      corroboratingSignals: [signal({ id: "queue-depth-api-5-metrics", source: "metrics" })],
      action: scaleAction({ idempotencyKey: "scale-api-split-1" }),
      operator: sreOperator({ spendCapUsd: 100 }),
      rbac: rbac({ grants: ["remediation:apply"] }),
      costEstimateUsd: 9,
      spendLedger: { currentUsd: 90, capUsd: 100, scopeKey: "camp:staging", windowId: "2026-06" },
      decidedAt: "2026-06-28T02:37:00.000Z",
    });
    const second = evaluateRemediationSafety({
      priorEvents: first.events,
      signal: signal({ id: "queue-depth-api-6" }),
      corroboratingSignals: [signal({ id: "queue-depth-api-6-metrics", source: "metrics" })],
      action: scaleAction({ idempotencyKey: "scale-api-split-2" }),
      operator: sreOperator({ spendCapUsd: 100 }),
      rbac: rbac({ grants: ["remediation:apply"] }),
      costEstimateUsd: 2,
      spendLedger: { currentUsd: 90, capUsd: 100, scopeKey: "camp:staging", windowId: "2026-06" },
      decidedAt: "2026-06-28T02:38:00.000Z",
    });

    assert.equal(first.status, "allowed");
    assert.equal(second.status, "denied");
    assert.equal(second.decision.reason, "split-spend-cap-exceeded");
    assert.equal(second.decision.projectedSpendUsd, 101);
    assert.equal(second.denied.data.reason, "split-spend-cap-exceeded");
    assert.ok(!second.events.crew.some((event) => event.type === "crew.ActionApplied"));

    const replay = replayRemediationSafety(mergeEvents(first.events, second.events));
    assert.equal(replay.decisions, 2);
    assert.equal(replay.denied, 1);
    assert.equal(replay.spendByScope["camp:staging|2026-06"], 11);
  });
});

function signal({
  id,
  source = "slo-monitor",
  targetId = "api-route",
  provenance = { issuer: "spiffe://yard/acme/probe/slo", signature: "valid" },
}) {
  return {
    id,
    type: "slo.BudgetBurned",
    correlationId: `corr-${targetId}`,
    targetId,
    source,
    occurredAt: "2026-06-28T02:30:00.000Z",
    severity: "SEV2",
    provenance,
  };
}

function haltSpendAction() {
  return {
    kind: "halt-spend",
    target: { kind: "camp", id: "payments-prod" },
    environment: "prod",
    idempotencyKey: "halt-spend-payments-prod",
    conformanceState: "green",
    blastRadius: {
      scope: "camp",
      reversible: false,
      estimatedImpact: "medium",
    },
  };
}

function scaleAction({ idempotencyKey = "scale-api" } = {}) {
  return {
    kind: "scale",
    target: { kind: "resource", id: "api-route" },
    environment: "staging",
    idempotencyKey,
    conformanceState: "green",
    blastRadius: {
      scope: "resource",
      reversible: true,
      compensationPath: "scale:restore-previous",
      estimatedImpact: "low",
    },
  };
}

function sreOperator({
  scopedCapabilities = ["incident:read", "remediation:propose", "remediation:apply"],
  spendCapUsd = 50,
} = {}) {
  return {
    name: "SRE",
    svid: "spiffe://yard/acme/agent/sre",
    perAgentPolicy: {
      scopedCapabilities,
      spendCapUsd,
      requireApprovalGates: ["prod", "destroy", "over-budget"],
    },
    enginePort: "hobo:sre-engine/built-in@0.1.0",
  };
}

function rbac({ grants }) {
  return {
    subjectId: "spiffe://yard/acme/agent/sre",
    roles: ["sre-operator"],
    roleGrants: {
      "sre-operator": grants,
    },
  };
}

function mergeEvents(...eventSets) {
  return {
    crew: eventSets.flatMap((events) => events.crew ?? []),
    safety: eventSets.flatMap((events) => events.safety ?? []),
  };
}
