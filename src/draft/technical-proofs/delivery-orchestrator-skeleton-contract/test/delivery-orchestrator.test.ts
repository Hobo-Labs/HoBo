import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createDeliveryOrchestrator,
  replayRollout,
  validateRolloutEvent,
} from "../src/delivery-orchestrator.js";

const baseRollout = Object.freeze({
  rolloutId: "rollout_checkout_42",
  runId: "run_checkout_42",
  tenant: "tenant_a",
  actor: { kind: "service-account", id: "delivery-orchestrator", tenant: "tenant_a" },
  target: {
    service: "checkout-web",
    fromVersion: "checkout@sha256:old",
    toVersion: "checkout@sha256:new",
  },
  policy: {
    strategy: "open-delivery",
    steps: [
      {
        name: "deploy-dark",
        action: { kind: "deploy-dark", environment: "prod" },
        gateRefs: [{ kind: "synthetic", id: "dark-ready" }],
      },
      {
        name: "ramp-flag-10",
        action: {
          kind: "flag-ramp",
          flagKey: "checkout.new-flow",
          targeting: { percentage: 10 },
        },
        gateRefs: [{ kind: "slo", id: "checkout-red" }],
      },
      {
        name: "ramp-flag-100",
        action: {
          kind: "flag-ramp",
          flagKey: "checkout.new-flow",
          targeting: { percentage: 100 },
        },
        gateRefs: [{ kind: "slo", id: "checkout-red" }],
      },
    ],
  },
});

test("no-op rollout drives Started to Stepped to Promoted and is replayable from rollout events", async () => {
  const orchestrator = createDeliveryOrchestrator({
    now: fixedClock(),
  });

  const result = await orchestrator.runRollout({
    rollout: baseRollout,
  });

  assert.deepEqual(result.events.map((event) => event.type), [
    "rollout.Started",
    "rollout.GateEvaluated",
    "rollout.Stepped",
    "rollout.GateEvaluated",
    "rollout.Stepped",
    "rollout.GateEvaluated",
    "rollout.Stepped",
    "rollout.Promoted",
  ]);
  assert.equal(result.status.state, "promoted");
  assert.equal(result.status.currentStepIndex, 3);
  assert.deepEqual(result.status.completedSteps, ["deploy-dark", "ramp-flag-10", "ramp-flag-100"]);
  assert.deepEqual(
    result.events.find((event) => event.type === "rollout.Stepped" && event.data.stepIndex === 1)
      .data.step.action,
    {
      kind: "flag-ramp",
      flagKey: "checkout.new-flow",
      targeting: { percentage: 10 },
    },
  );

  for (const event of result.events) {
    assert.equal(validateRolloutEvent(event), event);
  }

  assert.deepEqual(replayRollout(result.events), result.status);
});

test("gate fail rolls back fail-safe after emitting the gate decision", async () => {
  const orchestrator = createDeliveryOrchestrator({ now: fixedClock() });

  const result = await orchestrator.runRollout({
    rollout: baseRollout,
    gateEvaluator: ({ step }) => ({
      decision: step.name === "ramp-flag-10" ? "fail" : "pass",
      reason: step.name === "ramp-flag-10" ? "slo burn-rate above threshold" : "healthy",
    }),
  });

  assert.deepEqual(result.events.map((event) => event.type), [
    "rollout.Started",
    "rollout.GateEvaluated",
    "rollout.Stepped",
    "rollout.GateEvaluated",
    "rollout.Failed",
    "rollout.RolledBack",
  ]);
  assert.equal(result.status.state, "rolled-back");
  assert.equal(result.status.rollbackReason, "slo burn-rate above threshold");
});

test("node-loss resume continues at the same step without duplicating earlier step events", async () => {
  const orchestrator = createDeliveryOrchestrator({ now: fixedClock() });

  const firstLease = await orchestrator.runRollout({
    rollout: baseRollout,
    executionBudget: { maxSteps: 1 },
  });
  assert.deepEqual(firstLease.events.map((event) => event.type), [
    "rollout.Started",
    "rollout.GateEvaluated",
    "rollout.Stepped",
  ]);
  assert.equal(firstLease.status.state, "running");
  assert.equal(firstLease.status.currentStepIndex, 1);

  const resumed = await orchestrator.runRollout({
    rollout: baseRollout,
    eventLog: firstLease.events,
  });

  const fullLog = [...firstLease.events, ...resumed.events];
  assert.equal(resumed.status.state, "promoted");
  assert.equal(countStep(fullLog, 0), 1);
  assert.equal(countStep(fullLog, 1), 1);
  assert.equal(countStep(fullLog, 2), 1);
  assert.deepEqual(replayRollout(fullLog), resumed.status);
});

test("every executed step and gate is an event", async () => {
  const orchestrator = createDeliveryOrchestrator({ now: fixedClock() });

  const result = await orchestrator.runRollout({
    rollout: baseRollout,
  });

  const gateEvents = result.events.filter((event) => event.type === "rollout.GateEvaluated");
  const stepEvents = result.events.filter((event) => event.type === "rollout.Stepped");

  assert.equal(gateEvents.length, baseRollout.policy.steps.length);
  assert.equal(stepEvents.length, baseRollout.policy.steps.length);
  assert.deepEqual(gateEvents.map((event) => event.data.stepIndex), [0, 1, 2]);
  assert.deepEqual(stepEvents.map((event) => event.data.stepIndex), [0, 1, 2]);
});

test("duplicate step delivery is memoized by step index", async () => {
  const orchestrator = createDeliveryOrchestrator({ now: fixedClock() });

  const first = await orchestrator.runRollout({
    rollout: baseRollout,
    executionBudget: { maxSteps: 1 },
  });
  const duplicatedFirstStep = [
    ...first.events,
    {
      ...first.events.find((event) => event.type === "rollout.Stepped"),
      id: "manual-duplicate-step-event",
    },
  ];

  const resumed = await orchestrator.runRollout({
    rollout: baseRollout,
    eventLog: duplicatedFirstStep,
  });
  const fullLog = [...duplicatedFirstStep, ...resumed.events];

  assert.equal(countStep(resumed.events, 0), 0);
  assert.deepEqual(replayRollout(fullLog).completedSteps, [
    "deploy-dark",
    "ramp-flag-10",
    "ramp-flag-100",
  ]);
  assert.equal(resumed.status.state, "promoted");
  assert.deepEqual(resumed.status.ignoredDuplicates, [
    { type: "rollout.Stepped", stepIndex: 0, eventId: "manual-duplicate-step-event" },
  ]);
});

test("zero-step rollout promotes immediately and leaves an audit trail", async () => {
  const orchestrator = createDeliveryOrchestrator({ now: fixedClock() });

  const result = await orchestrator.runRollout({
    rollout: {
      ...baseRollout,
      rolloutId: "rollout_zero_steps",
      policy: { ...baseRollout.policy, steps: [] },
    },
  });

  assert.deepEqual(result.events.map((event) => event.type), [
    "rollout.Started",
    "rollout.Promoted",
  ]);
  assert.equal(result.events[1].data.reason, "no-steps");
  assert.deepEqual(result.status.completedSteps, []);
  assert.equal(result.status.state, "promoted");
});

test("gate hook throwing is treated as fail to rollback, not a stuck rollout", async () => {
  const orchestrator = createDeliveryOrchestrator({ now: fixedClock() });

  const result = await orchestrator.runRollout({
    rollout: baseRollout,
    gateEvaluator: () => {
      throw new Error("gate subsystem unavailable");
    },
  });

  assert.deepEqual(result.events.map((event) => event.type), [
    "rollout.Started",
    "rollout.GateEvaluated",
    "rollout.Failed",
    "rollout.RolledBack",
  ]);
  assert.equal(result.status.state, "rolled-back");
  assert.equal(result.events[1].data.decision, "fail");
  assert.equal(result.events[1].data.reason, "gate hook threw: gate subsystem unavailable");
});

function fixedClock() {
  let tick = 0;
  return () => `2026-06-25T20:${String(tick++).padStart(2, "0")}:00.000Z`;
}

function countStep(events, stepIndex) {
  return events.filter(
    (event) => event.type === "rollout.Stepped" && event.data.stepIndex === stepIndex,
  ).length;
}
