import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { foldCrewStream } from "../../crew-event-contract/src/crew-event-contract.js";
import {
  evaluateRunawayRemediation,
  replayRunawayGuard,
} from "../src/runaway-remediation-guard.js";

describe("runaway remediation guard contract", () => {
  it("trips a circuit breaker after self-caused flapping without a second apply", () => {
    const first = evaluateRunawayRemediation({
      signal: signal({ id: "slo-burn-api-1" }),
      action: failoverAction({ idempotencyKey: "failover-api-staging" }),
      decidedAt: "2026-06-28T01:00:00.000Z",
      maxSelfCausedCycles: 2,
    });

    assert.equal(first.status, "applied");
    assert.deepEqual(
      first.events.crew.map((event) => event.type),
      ["policy.Decided", "crew.ActionProposed", "crew.ActionApplied"],
    );

    const second = evaluateRunawayRemediation({
      priorEvents: first.events,
      signal: signal({
        id: "slo-burn-api-2",
        causedByActionId: first.applied.id,
      }),
      action: failoverAction({ idempotencyKey: "failover-api-staging" }),
      decidedAt: "2026-06-28T01:02:00.000Z",
      maxSelfCausedCycles: 2,
    });

    assert.equal(second.status, "cooldown");
    assert.equal(second.guard.reason, "self-causation-cooldown");
    assert.ok(!second.events.crew.some((event) => event.type === "crew.ActionApplied"));
    assert.ok(second.events.crew.some((event) => event.type === "crew.ActionDenied"));

    const third = evaluateRunawayRemediation({
      priorEvents: mergeEvents(first.events, second.events),
      signal: signal({
        id: "slo-burn-api-3",
        causedByActionId: first.applied.id,
      }),
      action: failoverAction({ idempotencyKey: "failover-api-staging" }),
      decidedAt: "2026-06-28T01:04:00.000Z",
      maxSelfCausedCycles: 2,
    });

    assert.equal(third.status, "escalated");
    assert.equal(third.guard.reason, "self-causation-circuit-breaker");
    assert.ok(third.events.crew.some((event) => event.type === "crew.HandoffRequested"));
    assert.ok(!third.events.crew.some((event) => event.type === "crew.ActionApplied"));

    const replay = replayRunawayGuard(mergeEvents(first.events, second.events, third.events));
    assert.equal(replay.status, "escalated");
    assert.equal(replay.appliedActions, 1);
    assert.equal(foldCrewStream(mergeEvents(first.events, second.events, third.events).crew).actions.length, 3);

    const afterBreaker = evaluateRunawayRemediation({
      priorEvents: mergeEvents(first.events, second.events, third.events),
      signal: signal({ id: "slo-burn-api-4", occurredAt: "2026-06-28T01:20:00.000Z" }),
      action: failoverAction({ idempotencyKey: "failover-api-after-breaker" }),
      decidedAt: "2026-06-28T01:20:00.000Z",
    });

    assert.equal(afterBreaker.status, "escalated");
    assert.equal(afterBreaker.guard.reason, "circuit-breaker-open");
    assert.ok(!afterBreaker.events.crew.some((event) => event.type === "crew.ActionApplied"));
  });

  it("keeps blast radius monotonic across repeated remediation attempts", () => {
    const first = evaluateRunawayRemediation({
      signal: signal({ id: "queue-depth-api-1" }),
      action: scaleAction({ scope: "resource", estimatedImpact: "low" }),
      decidedAt: "2026-06-28T01:10:00.000Z",
    });
    const widened = evaluateRunawayRemediation({
      priorEvents: first.events,
      signal: signal({ id: "queue-depth-api-2" }),
      action: scaleAction({ scope: "region", estimatedImpact: "medium" }),
      decidedAt: "2026-06-28T01:11:00.000Z",
    });

    assert.equal(widened.status, "escalated");
    assert.equal(widened.guard.reason, "blast-radius-widening");
    assert.equal(widened.guard.previousBlastRadius.maxResources, 1);
    assert.equal(widened.guard.proposedBlastRadius.maxResources, 50);
    assert.ok(!widened.events.crew.some((event) => event.type === "crew.ActionApplied"));
  });

  it("enforces a per-action cooldown even without explicit self-causation evidence", () => {
    const first = evaluateRunawayRemediation({
      signal: signal({ id: "queue-depth-api-cooldown-1", occurredAt: "2026-06-28T01:40:00.000Z" }),
      action: scaleAction({ scope: "resource", estimatedImpact: "low" }),
      decidedAt: "2026-06-28T01:40:00.000Z",
      cooldownMs: 10 * 60 * 1000,
    });
    const repeated = evaluateRunawayRemediation({
      priorEvents: first.events,
      signal: signal({ id: "queue-depth-api-cooldown-2", occurredAt: "2026-06-28T01:44:00.000Z" }),
      action: scaleAction({ scope: "resource", estimatedImpact: "low" }),
      decidedAt: "2026-06-28T01:45:00.000Z",
      cooldownMs: 10 * 60 * 1000,
    });

    assert.equal(repeated.status, "cooldown");
    assert.equal(repeated.guard.reason, "action-cooldown");
    assert.ok(!repeated.events.crew.some((event) => event.type === "crew.ActionApplied"));
  });

  it("rate-limits repeated action kinds even when idempotency keys change", () => {
    const first = evaluateRunawayRemediation({
      signal: signal({ id: "queue-depth-api-rate-1", occurredAt: "2026-06-28T01:50:00.000Z" }),
      action: scaleAction({ scope: "resource", estimatedImpact: "low", idempotencyKey: "scale-api-1" }),
      decidedAt: "2026-06-28T01:50:00.000Z",
      cooldownMs: 0,
      rateLimitWindowMs: 10 * 60 * 1000,
      maxActionsPerWindow: 1,
    });
    const repeatedKind = evaluateRunawayRemediation({
      priorEvents: first.events,
      signal: signal({ id: "queue-depth-api-rate-2", occurredAt: "2026-06-28T01:55:00.000Z" }),
      action: scaleAction({ scope: "resource", estimatedImpact: "low", idempotencyKey: "scale-api-2" }),
      decidedAt: "2026-06-28T01:55:00.000Z",
      cooldownMs: 0,
      rateLimitWindowMs: 10 * 60 * 1000,
      maxActionsPerWindow: 1,
    });

    assert.equal(repeatedKind.status, "cooldown");
    assert.equal(repeatedKind.guard.reason, "action-rate-limit");
    assert.ok(!repeatedKind.events.crew.some((event) => event.type === "crew.ActionApplied"));
  });

  it("does not let a causal loop widen blast radius across targets", () => {
    const first = evaluateRunawayRemediation({
      signal: signal({ id: "alert-api-cross-target-1", occurredAt: "2026-06-28T02:00:00.000Z" }),
      action: failoverAction({ targetId: "api-route", idempotencyKey: "failover-api-cross-target" }),
      decidedAt: "2026-06-28T02:00:00.000Z",
    });
    const widenedTarget = evaluateRunawayRemediation({
      priorEvents: first.events,
      signal: signal({
        id: "alert-billing-cross-target-1",
        targetId: "billing-db",
        causedByActionId: first.applied.id,
        occurredAt: "2026-06-28T02:01:00.000Z",
      }),
      action: resyncAction({
        targetId: "billing-db",
        idempotencyKey: "resync-billing-db-widened",
        scope: "region",
        estimatedImpact: "medium",
      }),
      decidedAt: "2026-06-28T02:01:00.000Z",
    });

    assert.equal(widenedTarget.status, "escalated");
    assert.equal(widenedTarget.guard.reason, "blast-radius-widening");
    assert.ok(!widenedTarget.events.crew.some((event) => event.type === "crew.ActionApplied"));
  });

  it("detects two operators fixing each other's symptoms as a causation loop", () => {
    const first = evaluateRunawayRemediation({
      signal: signal({ id: "alert-api-1" }),
      action: failoverAction({ targetId: "api-route", idempotencyKey: "failover-api" }),
      operator: sreOperator(),
      decidedAt: "2026-06-28T01:20:00.000Z",
    });
    const second = evaluateRunawayRemediation({
      priorEvents: first.events,
      signal: signal({
        id: "alert-db-1",
        targetId: "billing-db",
        causedByActionId: first.applied.id,
      }),
      action: resyncAction({ targetId: "billing-db", idempotencyKey: "resync-billing-db" }),
      operator: gitOpsOperator(),
      decidedAt: "2026-06-28T01:21:00.000Z",
      maxSelfCausedCycles: 4,
    });
    const third = evaluateRunawayRemediation({
      priorEvents: mergeEvents(first.events, second.events),
      signal: signal({
        id: "alert-api-2",
        causedByActionId: second.applied.id,
      }),
      action: failoverAction({ targetId: "api-route", idempotencyKey: "failover-api-again" }),
      operator: sreOperator(),
      decidedAt: "2026-06-28T01:22:00.000Z",
    });

    assert.equal(second.status, "applied");
    assert.equal(third.status, "escalated");
    assert.equal(third.guard.reason, "cross-operator-causation-loop");
    assert.deepEqual(third.guard.loopOperators, ["SRE", "GitOps"]);
    assert.ok(!third.events.crew.some((event) => event.type === "crew.ActionApplied"));
  });

  it("hard-stops an amplifying fix to A2H", () => {
    const first = evaluateRunawayRemediation({
      signal: signal({ id: "slo-burn-api-amp-1" }),
      action: failoverAction({ idempotencyKey: "failover-api-amp" }),
      decidedAt: "2026-06-28T01:30:00.000Z",
    });
    const amplified = evaluateRunawayRemediation({
      priorEvents: first.events,
      signal: signal({
        id: "slo-burn-api-amp-2",
        causedByActionId: first.applied.id,
        observedEffect: {
          severityBefore: "SEV2",
          severityAfter: "SEV1",
          blastRadiusAfter: { scope: "region", estimatedImpact: "high" },
        },
      }),
      action: failoverAction({ idempotencyKey: "failover-api-amp" }),
      decidedAt: "2026-06-28T01:31:00.000Z",
    });

    assert.equal(amplified.status, "escalated");
    assert.equal(amplified.guard.reason, "outage-amplification");
    assert.equal(amplified.events.crew[0].data.effect, "deny");
    assert.ok(amplified.events.crew.some((event) => event.type === "crew.HandoffRequested"));
    assert.ok(!amplified.events.crew.some((event) => event.type === "crew.ActionApplied"));
  });
});

function signal({
  id,
  targetId = "api-route",
  causedByActionId,
  occurredAt = "2026-06-28T01:00:00.000Z",
  observedEffect,
}) {
  return {
    id,
    type: "slo.BudgetBurned",
    correlationId: `corr-${targetId}`,
    targetId,
    occurredAt,
    severity: "SEV2",
    ...(causedByActionId ? { causedByActionId } : undefined),
    ...(observedEffect ? { observedEffect } : undefined),
  };
}

function failoverAction({
  targetId = "api-route",
  idempotencyKey = "failover-api",
  scope = "resource",
  estimatedImpact = "low",
} = {}) {
  return {
    kind: "failover",
    target: { kind: "region", id: targetId },
    environment: "staging",
    idempotencyKey,
    conformanceState: "green",
    blastRadius: {
      scope,
      reversible: true,
      compensationPath: "failover:restore-primary",
      estimatedImpact,
    },
  };
}

function scaleAction({ scope, estimatedImpact, idempotencyKey = `scale-api-${scope}` }) {
  return {
    kind: "scale",
    target: { kind: "resource", id: "api-route" },
    environment: "staging",
    idempotencyKey,
    conformanceState: "green",
    blastRadius: {
      scope,
      reversible: true,
      compensationPath: "scale:restore-previous",
      estimatedImpact,
    },
  };
}

function resyncAction({
  targetId,
  idempotencyKey,
  scope = "resource",
  estimatedImpact = "low",
}) {
  return {
    kind: "resync",
    target: { kind: "resource", id: targetId },
    environment: "staging",
    idempotencyKey,
    conformanceState: "green",
    blastRadius: {
      scope,
      reversible: true,
      compensationPath: "resync:restore-last-known-good",
      estimatedImpact,
    },
  };
}

function sreOperator() {
  return {
    name: "SRE",
    svid: "spiffe://yard/acme/agent/sre",
    perAgentPolicy: {
      scopedCapabilities: ["incident:read", "remediation:apply"],
      spendCapUsd: 50,
      requireApprovalGates: ["prod", "destroy", "over-budget"],
    },
    enginePort: "hobo:sre-engine/built-in@0.1.0",
  };
}

function gitOpsOperator() {
  return {
    name: "GitOps",
    svid: "spiffe://yard/acme/agent/gitops",
    perAgentPolicy: {
      scopedCapabilities: ["pipeline:read", "deployment:promote", "remediation:apply"],
      spendCapUsd: 25,
      requireApprovalGates: ["prod", "destroy", "over-budget"],
    },
    enginePort: "hobo:gitops-engine/built-in@0.1.0",
  };
}

function mergeEvents(...eventSets) {
  return {
    crew: eventSets.flatMap((events) => events.crew ?? []),
  };
}
