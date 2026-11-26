import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createRollbackCompensationEngine,
} from "../src/rollback-failure-compensation.js";

const baseRollback = Object.freeze({
  rolloutId: "rollout_checkout_rollback",
  runId: "run_checkout_rollback",
  tenant: "tenant_a",
  obligationId: "obligation_auto_revert_checkout",
  routeId: "checkout-public",
  fromVersion: "checkout@sha256:blue",
  toVersion: "checkout@sha256:green",
});

test("router rollback retries idempotently within budget and succeeds", async () => {
  const executor = recordingExecutor({
    "router-flip-back": [
      { status: "failed", reason: "gateway timeout" },
      { status: "failed", reason: "lease not yet visible" },
      { status: "applied", observedState: { traffic: "blue-100" } },
    ],
  });
  const engine = deterministicEngine();

  const result = await engine.compensate({
    rollback: baseRollback,
    plan: rollbackPlan(),
    retryBudget: { maxAttemptsPerStep: 3 },
    executor,
  });

  assert.equal(result.state.status, "rolled-back");
  assert.deepEqual(
    executor.commands.map((command) => [command.stepId, command.idempotencyKey]),
    [
      ["router-flip-back", "rollout_checkout_rollback:rollback:router-flip-back"],
      ["router-flip-back", "rollout_checkout_rollback:rollback:router-flip-back"],
      ["router-flip-back", "rollout_checkout_rollback:rollback:router-flip-back"],
      ["flag-revert", "rollout_checkout_rollback:rollback:flag-revert"],
      ["green-reap", "rollout_checkout_rollback:rollback:green-reap"],
    ],
  );
  assert.deepEqual(result.state.completedSteps, ["router-flip-back", "flag-revert", "green-reap"]);
  assert.equal(result.state.autoRevertObligation.status, "satisfied");
  assert.equal(result.events.at(-1).type, "rollout.RolledBack");
});

test("exhausted rollback compensation escalates to needs-human with exact partial state", async () => {
  const executor = recordingExecutor({
    "flag-revert": [
      { status: "failed", reason: "flag store unavailable" },
      { status: "failed", reason: "flag store still unavailable" },
    ],
  });
  const engine = deterministicEngine();

  const result = await engine.compensate({
    rollback: baseRollback,
    plan: rollbackPlan(),
    retryBudget: { maxAttemptsPerStep: 2 },
    executor,
  });

  assert.equal(result.state.status, "needs-human");
  assert.deepEqual(result.state.completedSteps, ["router-flip-back"]);
  assert.deepEqual(result.state.incompleteSteps, ["flag-revert", "green-reap"]);
  assert.deepEqual(result.state.attemptsByStep, {
    "router-flip-back": 1,
    "flag-revert": 2,
  });
  assert.deepEqual(result.state.autoRevertObligation, {
    id: baseRollback.obligationId,
    kind: "auto-revert",
    status: "unsatisfied",
    blocking: true,
  });
  assert.equal(result.events.at(-1).type, "rollout.NeedsHuman");
  assert.deepEqual(result.events.at(-1).data.partialState, {
    completedSteps: ["router-flip-back"],
    incompleteSteps: ["flag-revert", "green-reap"],
    attemptsByStep: {
      "router-flip-back": 1,
      "flag-revert": 2,
    },
    latestResultsByStep: {
      "router-flip-back": { status: "applied" },
      "flag-revert": { status: "failed", reason: "flag store still unavailable" },
    },
  });
});

test("resume completes only unfinished compensation steps", async () => {
  const executor = recordingExecutor();
  const engine = deterministicEngine();

  const result = await engine.compensate({
    rollback: baseRollback,
    plan: rollbackPlan(),
    eventLog: routerAlreadyCompensatedEvents(),
    executor,
  });

  assert.equal(result.state.status, "rolled-back");
  assert.deepEqual(
    executor.commands.map((command) => command.stepId),
    ["flag-revert", "green-reap"],
  );
  assert.deepEqual(result.state.completedSteps, ["router-flip-back", "flag-revert", "green-reap"]);
  assert.equal(
    result.events.some((event) => event.data.stepId === "router-flip-back"),
    false,
    "completed router rollback is not re-run",
  );
});

test("observed completion prevents destructive retry after a false failure report", async () => {
  const executor = recordingExecutor({
    "router-flip-back": [
      {
        status: "failed",
        reason: "provider returned stale timeout",
        observedComplete: true,
        observedState: { traffic: "blue-100" },
      },
    ],
  });
  const engine = deterministicEngine();

  const result = await engine.compensate({
    rollback: baseRollback,
    plan: rollbackPlan(),
    retryBudget: { maxAttemptsPerStep: 3 },
    executor,
  });

  assert.equal(result.state.status, "rolled-back");
  assert.equal(
    executor.commands.filter((command) => command.stepId === "router-flip-back").length,
    1,
  );
  const applied = result.events.find(
    (event) => event.type === "rollout.RollbackCompensationApplied" &&
      event.data.stepId === "router-flip-back",
  );
  assert.equal(applied.data.observedCompletion, true);
  assert.equal(applied.data.result.reason, "provider returned stale timeout");
});

test("flag revert failure after traffic rollback escalates with the inconsistent observed state", async () => {
  const executor = recordingExecutor({
    "router-flip-back": [
      { status: "applied", observedState: { traffic: { blue: 100, green: 0 } } },
    ],
    "flag-revert": [
      {
        status: "failed",
        reason: "flag write rejected",
        observedState: { traffic: { blue: 100, green: 0 }, flag: "green-enabled" },
      },
      {
        status: "failed",
        reason: "flag write still rejected",
        observedState: { traffic: { blue: 100, green: 0 }, flag: "green-enabled" },
      },
    ],
  });
  const engine = deterministicEngine();

  const result = await engine.compensate({
    rollback: baseRollback,
    plan: rollbackPlan(),
    retryBudget: { maxAttemptsPerStep: 2 },
    executor,
  });

  assert.equal(result.state.status, "needs-human");
  assert.deepEqual(result.events.at(-1).data.partialState.latestResultsByStep, {
    "router-flip-back": {
      status: "applied",
      observedState: { traffic: { blue: 100, green: 0 } },
    },
    "flag-revert": {
      status: "failed",
      reason: "flag write still rejected",
      observedState: { traffic: { blue: 100, green: 0 }, flag: "green-enabled" },
    },
  });
  assert.deepEqual(result.events.at(-1).data.partialState.completedSteps, ["router-flip-back"]);
  assert.deepEqual(result.events.at(-1).data.partialState.incompleteSteps, ["flag-revert", "green-reap"]);
});

test("expired rollback deadline escalates after orchestrator flapping without more commands", async () => {
  const executor = recordingExecutor();
  const engine = deterministicEngine();

  const result = await engine.compensate({
    rollback: baseRollback,
    plan: rollbackPlan(),
    eventLog: [
      event(1, "rollout.RollbackCompensationStarted", {
        rolloutId: baseRollback.rolloutId,
        plan: rollbackPlan().map((step) => ({ id: step.id, kind: step.kind })),
        autoRevertObligation: {
          id: baseRollback.obligationId,
          kind: "auto-revert",
          status: "in-progress",
          blocking: true,
        },
      }),
    ],
    deadlineAt: "2026-06-28T19:09:59.000Z",
    executor,
  });

  assert.equal(result.state.status, "needs-human");
  assert.equal(result.events.at(-1).data.reason, "rollback-compensation-deadline-exceeded");
  assert.deepEqual(result.events.at(-1).data.partialState.incompleteSteps, [
    "router-flip-back",
    "flag-revert",
    "green-reap",
  ]);
  assert.deepEqual(executor.commands, []);
});

function deterministicEngine() {
  let nextId = 1;

  return createRollbackCompensationEngine({
    now: () => "2026-06-28T19:10:00.000Z",
    idFactory: (type) => `${type}-${nextId++}`,
  });
}

function rollbackPlan() {
  return [
    {
      id: "router-flip-back",
      kind: "gateway.rollbackTraffic",
      command: {
        routeId: baseRollback.routeId,
        restoredVersion: baseRollback.fromVersion,
        revertedVersion: baseRollback.toVersion,
      },
    },
    {
      id: "flag-revert",
      kind: "flag.revert",
      command: {
        flagKey: "checkout.new-flow",
        restoredValue: "blue",
      },
    },
    {
      id: "green-reap",
      kind: "deployment.reapGreen",
      command: {
        version: baseRollback.toVersion,
      },
    },
  ];
}

function recordingExecutor(script = {}) {
  const attempts = new Map();
  return {
    commands: [],
    async apply(command) {
      this.commands.push(command);
      const attempt = attempts.get(command.stepId) ?? 0;
      attempts.set(command.stepId, attempt + 1);
      return script[command.stepId]?.[attempt] ?? { status: "applied" };
    },
  };
}

function routerAlreadyCompensatedEvents() {
  return [
    event(1, "rollout.RollbackCompensationStarted", {
      rolloutId: baseRollback.rolloutId,
      plan: rollbackPlan().map((step) => ({ id: step.id, kind: step.kind })),
      autoRevertObligation: {
        id: baseRollback.obligationId,
        kind: "auto-revert",
        status: "in-progress",
        blocking: true,
      },
    }),
    event(2, "rollout.RollbackCompensationAttempted", {
      rolloutId: baseRollback.rolloutId,
      stepId: "router-flip-back",
      attempt: 1,
      idempotencyKey: "rollout_checkout_rollback:rollback:router-flip-back",
      result: { status: "applied", observedState: { traffic: "blue-100" } },
    }),
    event(3, "rollout.RollbackCompensationApplied", {
      rolloutId: baseRollback.rolloutId,
      stepId: "router-flip-back",
      idempotencyKey: "rollout_checkout_rollback:rollback:router-flip-back",
      result: { status: "applied", observedState: { traffic: "blue-100" } },
      observedCompletion: false,
    }),
  ];
}

function event(seq, type, data) {
  return {
    specversion: "1.0",
    id: `${type}-${seq}`,
    source: "hobo:delivery",
    type,
    subject: baseRollback.rolloutId,
    runId: baseRollback.runId,
    tenant: baseRollback.tenant,
    seq,
    time: `2026-06-28T19:0${seq}:00.000Z`,
    data,
  };
}
