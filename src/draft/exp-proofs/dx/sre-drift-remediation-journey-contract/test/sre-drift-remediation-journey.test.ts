import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { replayRemediationSafety } from "../../../../technical-proofs/remediation-safety-gate-contract/src/remediation-safety-gate.js";
import {
  evaluateCrewWritePolicy,
  replaySreDriftRemediationJourney,
  runSreDriftRemediationJourney,
  triageUnclassifiableIncident,
} from "../src/sre-drift-remediation-journey.js";

describe("SRE drift remediation journey contract", () => {
  it("proves prod drift is read, diagnosed, gated, approved, and reconciled idempotently", async () => {
    const journey = await runSreDriftRemediationJourney({
      drift: driftSignal({ environment: "prod" }),
      policies: { api: { mode: "heal", environment: "prod", estimatedImpact: "medium" } },
      approval: {
        approvedAt: "2026-06-28T09:10:00.000Z",
        approvedBy: "user:on-call",
      },
    });

    assert.equal(journey.status, "reconciled");
    assert.equal(journey.cli.inspect.causedBy[0].type, "resource.DriftDetected");
    assert.equal(journey.cli.drift.status, "detected");
    assert.ok(journey.cli.logs.items.some((item) => item.type === "resource.DriftDetected"));
    assert.equal(journey.diagnosis.diagnosis.evidence.length, 3);
    assert.equal(journey.waiting.status, "waiting-for-approval");
    assert.deepEqual(
      journey.waiting.events.policy.map((event) => event.type),
      ["policy.ObligationCreated"],
    );
    assert.ok(!journey.waiting.events.crew.some((event) => event.type === "crew.ActionApplied"));
    assert.equal(journey.approved.status, "applied");
    assert.ok(journey.approved.events.crew.some((event) => event.type === "crew.ActionApplied"));
    assert.equal(journey.reconcile.first.status, "deployed");
    assert.equal(journey.reconcile.second.status, "noop");

    const replay = replaySreDriftRemediationJourney(journey.eventStream);
    assert.equal(replay.status, "reconciled");
    assert.equal(replay.approvalGate.awaited, true);
    assert.equal(replay.approvalGate.approvedBy, "user:on-call");
    assert.deepEqual(replay.hoboUpStatuses, ["deployed", "noop"]);
  });

  it("auto-applies low-risk reversible drift through a rollback-capable canary", async () => {
    const journey = await runSreDriftRemediationJourney({
      drift: driftSignal({ environment: "staging" }),
      policies: { api: { mode: "heal", environment: "staging", estimatedImpact: "low" } },
    });

    assert.equal(journey.status, "reconciled");
    assert.equal(journey.waiting.status, "applied");
    assert.ok(!journey.eventStream.some((event) => event.type === "policy.ObligationCreated"));
    assert.ok(journey.eventStream.some((event) => event.type === "rollout.Promoted"));
    assert.ok(journey.eventStream.some((event) => event.type === "policy.Decided" && event.data.effect === "allow"));
  });

  it("escalates an unclassifiable incident to on-call with a deadline", () => {
    const result = triageUnclassifiableIncident({
      signal: {
        id: "vendor-unknown-1",
        type: "vendor.UnknownAnomaly",
        kind: "opaque-provider-event",
        correlationId: "corr-vendor-unknown",
        occurredAt: "2026-06-28T09:20:00.000Z",
      },
      deadlineAt: "2026-06-28T09:35:00.000Z",
    });

    assert.equal(result.status, "escalated");
    assert.equal(result.classification.failureClass, "unclassifiable");
    assert.equal(result.handoff.type, "crew.HandoffRequested");
    assert.equal(result.deadlineAt, "2026-06-28T09:35:00.000Z");
    assert.ok(!result.events.some((event) => event.type === "crew.ActionApplied"));
  });

  it("denies crew writes beyond scoped policy or spend cap and audits the denial", () => {
    const noScope = evaluateCrewWritePolicy({
      rbac: {
        subjectId: "spiffe://yard/acme/agent/sre",
        roles: ["sre-operator"],
        roleGrants: { "sre-operator": ["remediation:propose"] },
      },
      costEstimateUsd: 1,
    });
    assert.equal(noScope.status, "denied");
    assert.equal(noScope.decision.reason, "rbac-role-missing-remediation-apply");
    assert.equal(noScope.policyDecision.data.effect, "deny");
    assert.ok(noScope.events.safety.some((event) => event.type === "remediationSafety.Decided"));

    const spendCap = evaluateCrewWritePolicy({
      costEstimateUsd: 25,
      spendLedger: { currentUsd: 40, capUsd: 50, scopeKey: "camp:prod", windowId: "2026-06" },
    });
    assert.equal(spendCap.status, "denied");
    assert.equal(spendCap.decision.reason, "spend-cap-exceeded");
    assert.equal(replayRemediationSafety(spendCap.events).denied, 1);
  });

  it("blocks reconcile at a failing gate without provisioning a half-applied set", async () => {
    const journey = await runSreDriftRemediationJourney({
      drift: driftSignal({ environment: "prod" }),
      policies: { api: { mode: "heal", environment: "prod", estimatedImpact: "medium" } },
      approval: {
        approvedAt: "2026-06-28T09:40:00.000Z",
        approvedBy: "user:on-call",
      },
      reconcileGate: {
        status: "failed",
        reason: "policy gate still open",
        fix: "approve the matching obligation before reconcile",
      },
    });

    assert.equal(journey.status, "reconcile-blocked");
    assert.equal(journey.reconcile.first.status, "blocked");
    assert.ok(!journey.reconcile.first.events.some((event) => event.type === "resource.Provisioned"));
    assert.ok(!journey.reconcile.first.events.some((event) => event.type === "deployment.SetApplied"));
  });

  it("does not heal backward when the drift is adopted as new desired state", async () => {
    const journey = await runSreDriftRemediationJourney({
      drift: driftSignal({
        desiredSetRef: "set:desired@sha256-new",
        observedRef: "provider:observed@sha256-new",
      }),
      desiredStateDisposition: "adopt-observed",
    });

    assert.equal(journey.status, "desired-state-accepted");
    assert.equal(journey.cli.drift.status, "accepted-as-new-desired-state");
    assert.ok(!journey.eventStream.some((event) => event.type === "crew.ActionApplied"));
    assert.equal(replaySreDriftRemediationJourney(journey.eventStream).status, "desired-state-accepted");
  });

  it("rejects approval by the proposing SRE agent", async () => {
    const journey = await runSreDriftRemediationJourney({
      drift: driftSignal({ environment: "prod" }),
      policies: { api: { mode: "heal", environment: "prod", estimatedImpact: "medium" } },
      approval: {
        approvedAt: "2026-06-28T09:50:00.000Z",
        approvedBy: "spiffe://yard/acme/agent/sre",
      },
    });

    assert.equal(journey.status, "approval-denied");
    assert.ok(journey.eventStream.some((event) => event.type === "policy.ApprovalRejected"));
    assert.ok(!journey.eventStream.some((event) => event.type === "crew.ActionApplied"));
    assert.equal(journey.reconcile, null);
  });
});

function driftSignal({
  environment = "prod",
  desiredSetRef = "set:desired@sha256-good",
  observedRef = "provider:observed@sha256-drifted",
} = {}) {
  return {
    id: `drift-api-${environment}`,
    type: "resource.DriftDetected",
    resourceId: "api",
    environment,
    occurredAt: "2026-06-28T09:00:00.000Z",
    correlationId: `corr-api-${environment}`,
    incidentId: `incident-api-${environment}`,
    severity: "SEV2",
    desiredSetRef,
    observedRef,
  };
}
