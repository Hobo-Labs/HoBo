import assert from "node:assert/strict";
import { test } from "vitest";

import {
  convergeStuckRollout,
  createInMemoryRecoveryLease,
  rolloutEvent,
} from "../src/stuck-rollout-convergence.js";

import {
  replayRollout,
  validateRolloutEvent,
} from "../../delivery-orchestrator-skeleton-contract/src/delivery-orchestrator.js";

const baseRollout = Object.freeze({
  rolloutId: "rollout_checkout_stuck",
  runId: "run_checkout_stuck",
  tenant: "tenant_a",
  target: {
    service: "checkout-web",
    routeId: "checkout-public",
    fromVersion: "checkout@sha256:blue",
    toVersion: "checkout@sha256:green",
  },
  policy: {
    strategy: "progressive",
    steps: [
      {
        name: "deploy-dark",
        action: { kind: "deploy-dark", environment: "prod" },
        gateRefs: [{ kind: "synthetic", id: "dark-ready" }],
      },
      {
        name: "shift-50",
        action: { kind: "gateway.shiftTraffic", routeId: "checkout-public", toWeight: 50 },
        gateRefs: [{ kind: "slo", id: "checkout-red", timeoutMs: 300000 }],
      },
      {
        name: "shift-100",
        action: { kind: "gateway.shiftTraffic", routeId: "checkout-public", toWeight: 100 },
        gateRefs: [{ kind: "slo", id: "checkout-red", timeoutMs: 300000 }],
      },
    ],
  },
});

test("unresolved gate hits its progress deadline and rolls back to a safe terminal state", () => {
  const eventLog = [
    event("rollout.Started", {
      rolloutId: baseRollout.rolloutId,
      target: baseRollout.target,
      policy: baseRollout.policy,
      warnings: [],
    }),
    event("rollout.GateEvaluated", {
      rolloutId: baseRollout.rolloutId,
      stepIndex: 0,
      step: baseRollout.policy.steps[0],
      decision: "pass",
      reason: "dark deploy ready",
      gateRefs: baseRollout.policy.steps[0].gateRefs,
    }),
    event("rollout.Stepped", {
      rolloutId: baseRollout.rolloutId,
      stepIndex: 0,
      step: baseRollout.policy.steps[0],
      state: "running",
    }),
    event("rollout.GateEvaluated", {
      rolloutId: baseRollout.rolloutId,
      stepIndex: 1,
      step: baseRollout.policy.steps[1],
      decision: "hold",
      reason: "metric window still pending",
      gateRefs: baseRollout.policy.steps[1].gateRefs,
    }, "2026-06-28T19:01:00.000Z"),
  ];

  const result = convergeStuckRollout({
    rollout: baseRollout,
    eventLog,
    observedState: unchangedTraffic(),
    progressDeadlineMs: 300000,
    now: () => "2026-06-28T19:07:00.000Z",
  });

  assert.equal(result.status.state, "rolled-back");
  assert.deepEqual(result.actions.map((action) => action.kind), ["gateway.rollbackTraffic"]);
  assert.deepEqual(result.events.map((rolloutEvent) => rolloutEvent.type), [
    "rollout.Failed",
    "rollout.RolledBack",
  ]);
  assert.equal(result.events[0].data.reason, "progress-deadline-exceeded: metric window still pending");
  assert.equal(result.events[0].data.dangling, false);
  assert.equal(result.events[1].data.restoredVersion, baseRollout.target.fromVersion);
  for (const produced of result.events) {
    assert.equal(validateRolloutEvent(produced), produced);
  }
});

test("half-applied router flip is detected from observed traffic and rolled back instead of left split", () => {
  const eventLog = [
    event("rollout.Started", {
      rolloutId: baseRollout.rolloutId,
      target: baseRollout.target,
      policy: baseRollout.policy,
      warnings: [],
    }),
    event("rollout.GateEvaluated", {
      rolloutId: baseRollout.rolloutId,
      stepIndex: 0,
      step: baseRollout.policy.steps[0],
      decision: "pass",
      reason: "dark deploy ready",
      gateRefs: baseRollout.policy.steps[0].gateRefs,
    }),
    event("rollout.Stepped", {
      rolloutId: baseRollout.rolloutId,
      stepIndex: 0,
      step: baseRollout.policy.steps[0],
      state: "running",
    }),
    event("rollout.GateEvaluated", {
      rolloutId: baseRollout.rolloutId,
      stepIndex: 1,
      step: baseRollout.policy.steps[1],
      decision: "pass",
      reason: "gate passed before shift",
      gateRefs: baseRollout.policy.steps[1].gateRefs,
    }),
  ];

  const result = convergeStuckRollout({
    rollout: baseRollout,
    eventLog,
    observedState: {
      providerReported: "shift-success",
      split: {
        [baseRollout.target.fromVersion]: 50,
        [baseRollout.target.toVersion]: 50,
      },
      targetHealthy: false,
      rollbackConverged: true,
    },
    progressDeadlineMs: 120000,
    now: () => "2026-06-28T19:05:00.000Z",
  });

  assert.equal(result.status.state, "rolled-back");
  assert.equal(result.events[0].data.reason, "observed-traffic-mismatch");
  assert.deepEqual(result.events[0].data.observed.split, {
    [baseRollout.target.fromVersion]: 50,
    [baseRollout.target.toVersion]: 50,
  });
  assert.deepEqual(result.actions, [
    {
      kind: "gateway.rollbackTraffic",
      routeId: baseRollout.target.routeId,
      restoredVersion: baseRollout.target.fromVersion,
      revertedVersion: baseRollout.target.toVersion,
      reason: "observed-traffic-mismatch",
    },
  ]);
});

test("orchestrator death recovery replays current step and does not duplicate completed steps", () => {
  const eventLog = [
    event("rollout.Started", {
      rolloutId: baseRollout.rolloutId,
      target: baseRollout.target,
      policy: baseRollout.policy,
      warnings: [],
    }),
    event("rollout.GateEvaluated", {
      rolloutId: baseRollout.rolloutId,
      stepIndex: 0,
      step: baseRollout.policy.steps[0],
      decision: "pass",
      reason: "dark deploy ready",
      gateRefs: baseRollout.policy.steps[0].gateRefs,
    }),
    event("rollout.Stepped", {
      rolloutId: baseRollout.rolloutId,
      stepIndex: 0,
      step: baseRollout.policy.steps[0],
      state: "running",
    }),
  ];

  const result = convergeStuckRollout({
    rollout: baseRollout,
    eventLog,
    observedState: {
      split: {
        [baseRollout.target.fromVersion]: 50,
        [baseRollout.target.toVersion]: 50,
      },
      targetHealthy: true,
      providerReported: "controller-crashed-after-shift",
    },
    progressDeadlineMs: 120000,
    now: () => "2026-06-28T19:05:00.000Z",
  });

  assert.equal(result.recoveredFromStepIndex, 1);
  assert.equal(result.status.state, "promoted");
  assert.deepEqual(result.events.map((rolloutEvent) => rolloutEvent.type), [
    "rollout.Stepped",
    "rollout.Stepped",
    "rollout.Promoted",
  ]);
  assert.deepEqual(result.events.map((rolloutEvent) => rolloutEvent.data.stepIndex).filter(Number.isInteger), [1, 2]);
  assert.equal(replayRollout([...eventLog, ...result.events]).state, "promoted");
});

test("non-convergeable rollback escalates to needs-human without retry-looping forever", () => {
  const eventLog = [
    event("rollout.Started", {
      rolloutId: baseRollout.rolloutId,
      target: baseRollout.target,
      policy: baseRollout.policy,
      warnings: [],
    }),
    event("rollout.GateEvaluated", {
      rolloutId: baseRollout.rolloutId,
      stepIndex: 1,
      step: baseRollout.policy.steps[1],
      decision: "pass",
      reason: "shift was allowed",
      gateRefs: baseRollout.policy.steps[1].gateRefs,
    }),
  ];

  const result = convergeStuckRollout({
    rollout: baseRollout,
    eventLog,
    observedState: {
      split: {
        [baseRollout.target.fromVersion]: 50,
        [baseRollout.target.toVersion]: 50,
      },
      targetHealthy: false,
      rollbackConverged: false,
      rollbackFailureReason: "gateway lease unavailable",
    },
    progressDeadlineMs: 1,
    now: () => "2026-06-28T19:05:00.000Z",
  });

  assert.equal(result.status.state, "needs-human");
  assert.deepEqual(result.events.map((rolloutEvent) => rolloutEvent.type), ["rollout.Failed"]);
  assert.equal(result.events[0].data.state, "needs-human");
  assert.equal(result.events[0].data.reason, "rollback-non-convergeable: gateway lease unavailable");
  assert.equal(result.actions.length, 1);
});

test("prior needs-human verdict is terminal on replay and does not emit more recovery work", () => {
  const eventLog = [
    event("rollout.Started", {
      rolloutId: baseRollout.rolloutId,
      target: baseRollout.target,
      policy: baseRollout.policy,
      warnings: [],
    }),
    event("rollout.Failed", {
      rolloutId: baseRollout.rolloutId,
      state: "needs-human",
      reason: "rollback-non-convergeable: gateway lease unavailable",
      dangling: true,
    }, "2026-06-28T19:01:00.000Z"),
  ];

  const result = convergeStuckRollout({
    rollout: baseRollout,
    eventLog,
    observedState: {
      split: {
        [baseRollout.target.fromVersion]: 50,
        [baseRollout.target.toVersion]: 50,
      },
      targetHealthy: false,
      rollbackConverged: false,
    },
    progressDeadlineMs: 1,
    now: () => "2026-06-28T19:05:00.000Z",
  });

  assert.equal(result.status.state, "needs-human");
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.actions, []);
});

test("single-writer lease prevents concurrent recovery attempts from double-driving a stuck rollout", () => {
  const recoveryLease = createInMemoryRecoveryLease();
  const eventLog = [
    event("rollout.Started", {
      rolloutId: baseRollout.rolloutId,
      target: baseRollout.target,
      policy: baseRollout.policy,
      warnings: [],
    }),
    event("rollout.GateEvaluated", {
      rolloutId: baseRollout.rolloutId,
      stepIndex: 1,
      step: baseRollout.policy.steps[1],
      decision: "hold",
      reason: "traffic split lease unavailable",
      gateRefs: baseRollout.policy.steps[1].gateRefs,
    }, "2026-06-28T19:01:00.000Z"),
  ];

  const first = convergeStuckRollout({
    rollout: baseRollout,
    eventLog,
    observedState: unchangedTraffic(),
    progressDeadlineMs: 1,
    now: () => "2026-06-28T19:02:00.000Z",
    recoveryLease,
    recoveryRunId: "worker-a",
  });
  const second = convergeStuckRollout({
    rollout: baseRollout,
    eventLog,
    observedState: unchangedTraffic(),
    progressDeadlineMs: 1,
    now: () => "2026-06-28T19:02:00.000Z",
    recoveryLease,
    recoveryRunId: "worker-b",
  });

  assert.equal(first.status.state, "rolled-back");
  assert.equal(second.status.state, "held-by-other-writer");
  assert.deepEqual(second.events, []);
  assert.deepEqual(second.actions, []);
});

test("rollout stuck at 50 percent terminates with a verdict after the deadline", () => {
  const result = convergeStuckRollout({
    rollout: baseRollout,
    eventLog: [
      event("rollout.Started", {
        rolloutId: baseRollout.rolloutId,
        target: baseRollout.target,
        policy: baseRollout.policy,
        warnings: [],
      }),
      event("rollout.GateEvaluated", {
        rolloutId: baseRollout.rolloutId,
        stepIndex: 1,
        step: baseRollout.policy.steps[1],
        decision: "pass",
        reason: "gate passed",
        gateRefs: baseRollout.policy.steps[1].gateRefs,
      }, "2026-06-28T19:01:00.000Z"),
    ],
    observedState: {
      split: {
        [baseRollout.target.fromVersion]: 50,
        [baseRollout.target.toVersion]: 50,
      },
      targetHealthy: false,
    },
    progressDeadlineMs: 1000,
    now: () => "2026-06-28T19:02:02.000Z",
  });

  assert.equal(result.status.state, "rolled-back");
  assert.equal(result.events.at(-1).type, "rollout.RolledBack");
  assert.notEqual(result.status.state, "running");
});

function event(type, data, time = "2026-06-28T19:00:00.000Z") {
  return rolloutEvent({
    rollout: baseRollout,
    type,
    data,
    time,
  });
}

function unchangedTraffic() {
  return {
    providerReported: "waiting",
    split: {
      [baseRollout.target.fromVersion]: 100,
      [baseRollout.target.toVersion]: 0,
    },
    targetHealthy: false,
    rollbackConverged: true,
  };
}
