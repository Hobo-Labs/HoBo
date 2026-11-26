import assert from "node:assert/strict";
import { test } from "vitest";

import {
  blueGreenStrategy,
  canaryStrategy,
  createDeploymentStrategySaga,
  progressiveStrategy,
  recreateStrategy,
  replayGatewayState,
} from "../src/deployment-strategy-saga-templates.js";

const baseTarget = Object.freeze({
  service: "checkout-web",
  routeId: "checkout-public",
  fromVersion: "checkout@sha256:blue",
  toVersion: "checkout@sha256:green",
});

test("canary shifts traffic in stages and auto-rolls back on injected regression signals", async () => {
  const gateway = recordingGateway();
  const saga = createDeploymentStrategySaga({ now: fixedClock() });

  const result = await saga.run({
    rollout: rolloutWith(canaryStrategy({
      routeId: baseTarget.routeId,
      percentages: [1, 10, 50, 100],
      healthGate: { id: "checkout-red", timeoutMs: 300000 },
      autoRollbackSignals: ["slo-burn", "golden-suite"],
    })),
    gateway,
    gateSignal: ({ step }) => {
      if (step.action.toWeight === 50) {
        return {
          signals: {
            sloBurn: { verdict: "rollback", sourceSeq: 17 },
            goldenSuite: { status: "passed", runId: "golden-17" },
          },
        };
      }

      return { decision: "pass", reason: "healthy" };
    },
  });

  assert.equal(result.status.state, "rolled-back");
  assert.deepEqual(
    gateway.commands.map((command) => [command.kind, command.toWeight ?? command.restoredWeight]),
    [
      ["gateway.shiftTraffic", 1],
      ["gateway.shiftTraffic", 10],
      ["gateway.shiftTraffic", 50],
      ["gateway.rollbackTraffic", 100],
    ],
  );
  assert.deepEqual(result.events.map((event) => event.type), [
    "rollout.Started",
    "rollout.Stepped",
    "rollout.GateEvaluated",
    "rollout.Stepped",
    "rollout.GateEvaluated",
    "rollout.Stepped",
    "rollout.GateEvaluated",
    "rollout.Failed",
    "rollout.RolledBack",
  ]);
  assert.equal(result.events[6].data.gateRefs[0].kind, "health");
  assert.deepEqual(result.events[6].data.signals, {
    sloBurn: { verdict: "rollback", sourceSeq: 17 },
    goldenSuite: { status: "passed", runId: "golden-17" },
  });
  assert.deepEqual(replayGatewayState(result.events), gateway.state);
});

test("canary auto-advances through passing gates and promotes at full green", async () => {
  const gateway = recordingGateway();
  const saga = createDeploymentStrategySaga({ now: fixedClock() });

  const result = await saga.run({
    rollout: rolloutWith(canaryStrategy({
      routeId: baseTarget.routeId,
      percentages: [25, 100],
      healthGate: { id: "checkout-red", timeoutMs: 300000 },
    })),
    gateway,
    gateSignal: () => ({ decision: "pass", reason: "healthy" }),
  });

  assert.equal(result.status.state, "promoted");
  assert.deepEqual(
    gateway.commands.map((command) => [command.kind, command.toWeight]),
    [
      ["gateway.shiftTraffic", 25],
      ["gateway.shiftTraffic", 100],
    ],
  );
  assert.deepEqual(
    result.events.filter((event) => event.type === "rollout.GateEvaluated").map((event) => event.data.reason),
    ["healthy", "healthy"],
  );
  assert.deepEqual(replayGatewayState(result.events), {
    routeId: baseTarget.routeId,
    activeVersion: baseTarget.toVersion,
    split: {
      [baseTarget.fromVersion]: 0,
      [baseTarget.toVersion]: 100,
    },
  });
});

test("blue-green flips the router only after the health gate and retains blue through soak", async () => {
  const gateway = recordingGateway();
  const saga = createDeploymentStrategySaga({ now: fixedClock() });

  const result = await saga.run({
    rollout: rolloutWith(blueGreenStrategy({
      routeId: baseTarget.routeId,
      healthGate: { id: "checkout-green-ready", timeoutMs: 180000 },
      soakSeconds: 900,
    })),
    gateway,
    gateSignal: ({ step }) => {
      if (step.action.kind === "gateway.flipRoute") {
        assert.deepEqual(gateway.commands.map((command) => command.kind), ["deployment.prepareGreen"]);
      }
      return { decision: "pass", reason: "green slot healthy" };
    },
  });

  assert.equal(result.status.state, "promoted");
  assert.deepEqual(gateway.commands.map((command) => command.kind), [
    "deployment.prepareGreen",
    "gateway.flipRoute",
    "deployment.retainBlue",
  ]);
  assert.deepEqual(result.events.map((event) => event.type), [
    "rollout.Started",
    "rollout.Stepped",
    "rollout.GateEvaluated",
    "rollout.Stepped",
    "rollout.Stepped",
    "rollout.Promoted",
  ]);
  assert.equal(gateway.state.activeVersion, baseTarget.toVersion);
  assert.equal(gateway.state.retainedVersion, baseTarget.fromVersion);
  assert.equal(gateway.state.reapAfter, "2026-06-26T19:18:00.000Z");
  assert.equal(result.events.at(-1).data.retainedVersion, baseTarget.fromVersion);
  assert.deepEqual(replayGatewayState(result.events), gateway.state);
});

test("blue-green can reap blue only after green health gate and soak gate pass", async () => {
  const gateway = recordingGateway();
  const saga = createDeploymentStrategySaga({ now: fixedClock() });

  const result = await saga.run({
    rollout: rolloutWith(blueGreenStrategy({
      routeId: baseTarget.routeId,
      healthGate: { id: "checkout-green-ready", timeoutMs: 180000 },
      soakSeconds: 900,
      reapAfterSoak: true,
    })),
    gateway,
    gateSignal: ({ step }) => ({
      decision: "pass",
      reason: step.action.kind === "deployment.reapBlue" ? "soak elapsed" : "green slot healthy",
    }),
  });

  assert.equal(result.status.state, "promoted");
  assert.deepEqual(gateway.commands.map((command) => command.kind), [
    "deployment.prepareGreen",
    "gateway.flipRoute",
    "deployment.retainBlue",
    "deployment.reapBlue",
  ]);
  assert.equal(gateway.commands.at(-1).retainedVersion, baseTarget.fromVersion);
  assert.equal(gateway.state.reapedVersion, baseTarget.fromVersion);
  assert.equal(gateway.state.retainedVersion, undefined);
  assert.deepEqual(
    result.events.filter((event) => event.type === "rollout.GateEvaluated").map((event) => [
      event.data.step.action.kind,
      event.data.reason,
    ]),
    [
      ["gateway.flipRoute", "green slot healthy"],
      ["deployment.reapBlue", "soak elapsed"],
    ],
  );
});

test("blue-green rejects blue reaping when the green health gate fails", async () => {
  const gateway = recordingGateway();
  const saga = createDeploymentStrategySaga({ now: fixedClock() });

  const result = await saga.run({
    rollout: rolloutWith(blueGreenStrategy({
      routeId: baseTarget.routeId,
      healthGate: { id: "checkout-green-ready", timeoutMs: 180000 },
      soakSeconds: 900,
      reapAfterSoak: true,
    })),
    gateway,
    gateSignal: ({ step }) => step.action.kind === "gateway.flipRoute"
      ? { decision: "fail", reason: "green slot failed health gate" }
      : { decision: "pass", reason: "soak elapsed" },
  });

  assert.equal(result.status.state, "rolled-back");
  assert.deepEqual(gateway.commands.map((command) => command.kind), [
    "deployment.prepareGreen",
    "gateway.rollbackTraffic",
  ]);
  assert.equal(result.status.rollbackReason, "green slot failed health gate");
});

test("malformed blue-green strategy cannot reap blue before green is healthy and retained", async () => {
  const gateway = recordingGateway();
  const saga = createDeploymentStrategySaga({ now: fixedClock() });

  const result = await saga.run({
    rollout: rolloutWith({
      kind: "deployment-strategy-template",
      strategy: "blue-green",
      routeId: baseTarget.routeId,
      steps: [
        {
          name: "reap-blue-too-early",
          gateTiming: "after",
          gateRefs: [],
          action: {
            kind: "deployment.reapBlue",
            routeId: baseTarget.routeId,
          },
        },
      ],
    }),
    gateway,
  });

  assert.equal(result.status.state, "rolled-back");
  assert.equal(result.status.rollbackReason, "cannot reap blue before green is healthy and retained");
  assert.deepEqual(gateway.commands.map((command) => command.kind), ["gateway.rollbackTraffic"]);
  assert.equal(gateway.state.reapedVersion, undefined);
});

test("recreate and progressive templates compile provider-agnostic saga steps", () => {
  const recreate = recreateStrategy({
    routeId: baseTarget.routeId,
    healthGate: { id: "checkout-new-ready", timeoutMs: 120000 },
  });
  const progressive = progressiveStrategy({
    routeId: baseTarget.routeId,
    stages: [
      { name: "internal", toWeight: 5, timeoutMs: 120000 },
      { name: "regional", toWeight: 25, timeoutMs: 180000 },
      { name: "global", toWeight: 100, timeoutMs: 300000 },
    ],
    autoRollbackSignals: ["slo-burn", "golden-suite"],
  });

  assert.deepEqual(recreate.steps.map((step) => [step.name, step.action.kind, step.gateTiming]), [
    ["stop-blue", "deployment.stopVersion", "after"],
    ["start-green", "deployment.startVersion", "after"],
    ["route-green", "gateway.shiftTraffic", "before"],
  ]);
  assert.deepEqual(progressive.steps.map((step) => [step.name, step.action.toWeight]), [
    ["progressive-internal", 5],
    ["progressive-regional", 25],
    ["progressive-global", 100],
  ]);
  assert.equal(progressive.steps[0].gateRefs.at(-1).signal, "golden-suite");
});

test("progressive strategy walks 1, 10, 50, and 100 percent with a gate after each split", async () => {
  const gateway = recordingGateway();
  const saga = createDeploymentStrategySaga({ now: fixedClock() });

  const result = await saga.run({
    rollout: rolloutWith(progressiveStrategy({
      routeId: baseTarget.routeId,
      stages: [
        { name: "one", toWeight: 1, timeoutMs: 120000 },
        { name: "ten", toWeight: 10, timeoutMs: 180000 },
        { name: "fifty", toWeight: 50, timeoutMs: 240000 },
        { name: "all", toWeight: 100, timeoutMs: 300000 },
      ],
    })),
    gateway,
    gateSignal: ({ step }) => ({ decision: "pass", reason: `${step.name}-healthy` }),
  });

  assert.equal(result.status.state, "promoted");
  assert.deepEqual(
    gateway.commands.map((command) => [command.kind, command.toWeight]),
    [
      ["gateway.shiftTraffic", 1],
      ["gateway.shiftTraffic", 10],
      ["gateway.shiftTraffic", 50],
      ["gateway.shiftTraffic", 100],
    ],
  );
  assert.deepEqual(
    result.events.filter((event) => event.type === "rollout.GateEvaluated").map((event) => [
      event.data.stepIndex,
      event.data.reason,
    ]),
    [
      [0, "progressive-one-healthy"],
      [1, "progressive-ten-healthy"],
      [2, "progressive-fifty-healthy"],
      [3, "progressive-all-healthy"],
    ],
  );
  assert.deepEqual(replayGatewayState(result.events), gateway.state);
});

test("staged traffic templates require a final full-green step before promotion", () => {
  assert.throws(
    () => canaryStrategy({
      routeId: baseTarget.routeId,
      percentages: [1, 10, 50],
      healthGate: { id: "checkout-red", timeoutMs: 120000 },
    }),
    /canary\.percentages must end at 100 before rollout promotion/,
  );

  assert.throws(
    () => progressiveStrategy({
      routeId: baseTarget.routeId,
      stages: [
        { name: "internal", toWeight: 5, timeoutMs: 120000 },
        { name: "regional", toWeight: 50, timeoutMs: 120000 },
      ],
    }),
    /progressive\.stages\[\]\.toWeight must end at 100 before rollout promotion/,
  );
});

test("health gate deadlines and hysteresis windows must be positive", () => {
  assert.throws(
    () => canaryStrategy({
      routeId: baseTarget.routeId,
      percentages: [1, 100],
      healthGate: { id: "checkout-red", timeoutMs: 0 },
    }),
    /healthGate\.timeoutMs must be a positive integer/,
  );

  assert.throws(
    () => canaryStrategy({
      routeId: baseTarget.routeId,
      percentages: [1, 100],
      healthGate: { id: "checkout-red", passAfterConsecutive: 0 },
    }),
    /healthGate\.passAfterConsecutive must be a positive integer/,
  );
});

test("flapping health signals require hysteresis and fail closed on timeout", async () => {
  const gateway = recordingGateway();
  const saga = createDeploymentStrategySaga({ now: fixedClock() });

  const result = await saga.run({
    rollout: rolloutWith(canaryStrategy({
      routeId: baseTarget.routeId,
      percentages: [1, 10, 100],
      healthGate: { id: "checkout-red", timeoutMs: 30000, passAfterConsecutive: 2 },
    })),
    gateway,
    gateSignal: () => ({
      healthSamples: ["healthy", "unhealthy", "healthy", "unhealthy", "healthy"],
      reason: "flapping sample window exhausted",
    }),
  });

  assert.equal(result.status.state, "rolled-back");
  assert.equal(result.events[2].data.decision, "fail");
  assert.equal(result.events[2].data.reason, "health-hysteresis-timeout");
  assert.deepEqual(gateway.commands.map((command) => command.kind), [
    "gateway.shiftTraffic",
    "gateway.rollbackTraffic",
  ]);
});

test("half-applied blue-green router flips are retried idempotently before the step completes", async () => {
  const gateway = recordingGateway({ partialFlipOnce: true });
  const saga = createDeploymentStrategySaga({ now: fixedClock() });

  const result = await saga.run({
    rollout: rolloutWith(blueGreenStrategy({
      routeId: baseTarget.routeId,
      healthGate: { id: "checkout-green-ready", timeoutMs: 180000 },
      soakSeconds: 900,
    })),
    gateway,
  });

  const flipCommands = gateway.commands.filter((command) => command.kind === "gateway.flipRoute");
  assert.equal(result.status.state, "promoted");
  assert.equal(flipCommands.length, 2);
  assert.equal(flipCommands[0].idempotencyKey, flipCommands[1].idempotencyKey);
  const flipEvent = result.events.find(
    (event) => event.type === "rollout.Stepped" && event.data.step.action.kind === "gateway.flipRoute",
  );
  assert.equal(flipEvent.data.actionResult.attempts, 2);
  assert.equal(gateway.state.activeVersion, baseTarget.toVersion);
});

test("half-applied blue-green router flips roll back if they do not converge", async () => {
  const gateway = recordingGateway({ partialFlipAlways: true });
  const saga = createDeploymentStrategySaga({ now: fixedClock() });

  const result = await saga.run({
    rollout: rolloutWith(blueGreenStrategy({
      routeId: baseTarget.routeId,
      healthGate: { id: "checkout-green-ready", timeoutMs: 180000 },
      soakSeconds: 900,
    })),
    gateway,
  });

  assert.equal(result.status.state, "rolled-back");
  assert.equal(result.status.rollbackReason, "gateway command gateway.flipRoute did not converge after 3 attempts");
  assert.equal(gateway.commands.filter((command) => command.kind === "gateway.flipRoute").length, 3);
  assert.deepEqual(gateway.commands.at(-1), {
    kind: "gateway.rollbackTraffic",
    routeId: baseTarget.routeId,
    restoredVersion: baseTarget.fromVersion,
    revertedVersion: baseTarget.toVersion,
    restoredWeight: 100,
    idempotencyKey: "rollout_checkout_canary:rollback:1",
  });
  assert.deepEqual(replayGatewayState(result.events), gateway.state);
});

test("canary stuck between stages on gate timeout rolls back to the old version", { timeout: 1000 }, async () => {
  const gateway = recordingGateway();
  const saga = createDeploymentStrategySaga({ now: fixedClock() });

  const result = await saga.run({
    rollout: rolloutWith(canaryStrategy({
      routeId: baseTarget.routeId,
      percentages: [1, 10, 50, 100],
      healthGate: { id: "checkout-red", timeoutMs: 1 },
    })),
    gateway,
    gateSignal: ({ step }) => step.action.toWeight === 10
      ? new Promise(() => {})
      : { decision: "pass", reason: "healthy" },
  });

  assert.equal(result.status.state, "rolled-back");
  assert.equal(result.status.rollbackReason, "gate timeout: canary-10 exceeded 1ms");
  assert.deepEqual(gateway.state, {
    routeId: baseTarget.routeId,
    activeVersion: baseTarget.fromVersion,
    split: {
      [baseTarget.fromVersion]: 100,
      [baseTarget.toVersion]: 0,
    },
  });
  assert.deepEqual(replayGatewayState(result.events), gateway.state);
});

test("progressive split acquisition hold stays on the same stage instead of skipping ahead", async () => {
  const saga = createDeploymentStrategySaga({ now: fixedClock() });
  const strategy = progressiveStrategy({
    routeId: baseTarget.routeId,
    stages: [
      { name: "one", toWeight: 1, timeoutMs: 120000 },
      { name: "ten", toWeight: 10, timeoutMs: 180000 },
      { name: "fifty", toWeight: 50, timeoutMs: 240000 },
      { name: "all", toWeight: 100, timeoutMs: 300000 },
    ],
  });

  const held = await saga.run({
    rollout: rolloutWith(strategy),
    gateway: recordingGateway({ holdShiftAtWeight: 10 }),
  });

  assert.equal(held.status.state, "running");
  assert.equal(held.status.currentStepIndex, 1);
  assert.deepEqual(
    held.events.filter((event) => event.type === "rollout.Stepped").map((event) => event.data.step.action.toWeight),
    [1],
  );
  assert.deepEqual(
    held.events.filter((event) => event.type === "rollout.GateEvaluated").map((event) => [
      event.data.step.action.toWeight,
      event.data.decision,
      event.data.reason,
    ]),
    [
      [1, "pass", "healthy"],
      [10, "hold", "traffic split lease unavailable"],
    ],
  );

  const resumedGateway = recordingGateway();
  const resumed = await saga.run({
    rollout: rolloutWith(strategy),
    eventLog: held.events,
    gateway: resumedGateway,
  });

  assert.equal(resumed.status.state, "promoted");
  assert.deepEqual(resumedGateway.commands.map((command) => command.toWeight), [10, 50, 100]);
});

test("terminal rollout replay does not execute later gateway steps", async () => {
  const saga = createDeploymentStrategySaga({ now: fixedClock() });
  const first = await saga.run({
    rollout: rolloutWith(canaryStrategy({
      routeId: baseTarget.routeId,
      percentages: [1, 10, 50, 100],
      healthGate: { id: "checkout-red", timeoutMs: 30000 },
    })),
    gateway: recordingGateway(),
    gateSignal: ({ step }) => step.action.toWeight === 10
      ? { decision: "fail", reason: "injected regression" }
      : { decision: "pass", reason: "healthy" },
  });
  const resumedGateway = recordingGateway();

  const resumed = await saga.run({
    rollout: rolloutWith(canaryStrategy({
      routeId: baseTarget.routeId,
      percentages: [1, 10, 50, 100],
      healthGate: { id: "checkout-red", timeoutMs: 30000 },
    })),
    eventLog: first.events,
    gateway: resumedGateway,
  });

  assert.equal(first.status.state, "rolled-back");
  assert.equal(resumed.status.state, "rolled-back");
  assert.deepEqual(resumed.events, []);
  assert.deepEqual(resumedGateway.commands, []);
});

function rolloutWith(strategy) {
  return {
    rolloutId: "rollout_checkout_canary",
    runId: "run_checkout_canary",
    tenant: "tenant_a",
    actor: { kind: "service-account", id: "delivery-harness", tenant: "tenant_a" },
    target: baseTarget,
    strategy,
  };
}

function recordingGateway(options = {}) {
  let partialFlipReturned = false;
  const gateway = {
    state: {
      routeId: baseTarget.routeId,
      activeVersion: baseTarget.fromVersion,
      split: {
        [baseTarget.fromVersion]: 100,
        [baseTarget.toVersion]: 0,
      },
    },
    commands: [],
    async apply(command) {
      this.commands.push(command);
      if (command.kind === "gateway.shiftTraffic") {
        if (command.toWeight === options.holdShiftAtWeight) {
          return {
            status: "held",
            reason: "traffic split lease unavailable",
            state: this.state,
          };
        }

        this.state = {
          routeId: command.routeId,
          activeVersion: command.toWeight === 100 ? command.toVersion : command.fromVersion,
          split: {
            [command.fromVersion]: 100 - command.toWeight,
            [command.toVersion]: command.toWeight,
          },
        };
        return { status: "applied", state: this.state };
      }

      if (command.kind === "gateway.rollbackTraffic") {
        this.state = {
          routeId: command.routeId,
          activeVersion: command.restoredVersion,
          split: {
            [command.restoredVersion]: command.restoredWeight,
            [command.revertedVersion]: 0,
          },
        };
        return { status: "applied", state: this.state };
      }

      if (command.kind === "deployment.prepareGreen") {
        this.state = {
          ...this.state,
          preparedVersion: command.toVersion,
        };
        return { status: "applied", state: this.state };
      }

      if (command.kind === "gateway.flipRoute") {
        if (options.partialFlipAlways || (options.partialFlipOnce && !partialFlipReturned)) {
          partialFlipReturned = true;
          this.state = {
            routeId: command.routeId,
            activeVersion: command.fromVersion,
            retainedVersion: command.fromVersion,
            partialFlip: true,
            split: {
              [command.fromVersion]: 50,
              [command.toVersion]: 50,
            },
          };
          return { status: "partial", state: this.state };
        }

        this.state = {
          routeId: command.routeId,
          activeVersion: command.toVersion,
          retainedVersion: command.fromVersion,
          split: {
            [command.fromVersion]: 0,
            [command.toVersion]: 100,
          },
        };
        return { status: "applied", state: this.state };
      }

      if (command.kind === "deployment.retainBlue") {
        this.state = {
          ...this.state,
          retainedVersion: command.retainedVersion,
          reapAfter: command.reapAfter,
        };
        return { status: "applied", state: this.state };
      }

      if (command.kind === "deployment.reapBlue") {
        const { retainedVersion: _retainedVersion, ...rest } = this.state;
        this.state = {
          ...rest,
          reapedVersion: command.retainedVersion,
        };
        return { status: "applied", state: this.state };
      }

      throw new Error(`unexpected command ${command.kind}`);
    },
  };

  return gateway;
}

function fixedClock() {
  let tick = 0;
  return () => `2026-06-26T19:${String(tick++).padStart(2, "0")}:00.000Z`;
}
