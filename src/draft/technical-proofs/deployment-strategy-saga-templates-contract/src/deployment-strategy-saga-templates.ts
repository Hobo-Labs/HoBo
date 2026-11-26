import {
  replayRollout,
  validateRolloutEvent,
} from "../../delivery-orchestrator-skeleton-contract/src/delivery-orchestrator.js";
import { isJsonString, isJsonObject } from "./json.js";


const EVENT_TYPES = Object.freeze({
  started: "rollout.Started",
  gateEvaluated: "rollout.GateEvaluated",
  stepped: "rollout.Stepped",
  promoted: "rollout.Promoted",
  failed: "rollout.Failed",
  rolledBack: "rollout.RolledBack",
});

export function canaryStrategy({
  routeId,
  percentages,
  healthGate,
  autoRollbackSignals = [],
}) {
  assertNonEmptyString(routeId, "canary.routeId");
  const weights = parsePercentages(percentages, "canary.percentages");
  assertEndsAtFullTraffic(weights, "canary.percentages");

  return deepFreeze({
    kind: "deployment-strategy-template",
    strategy: "canary",
    routeId,
    steps: weights.map((toWeight) => ({
      name: `canary-${toWeight}`,
      gateTiming: "after",
      gateRefs: gateRefsFor({ healthGate, autoRollbackSignals }),
      action: {
        kind: "gateway.shiftTraffic",
        routeId,
        toWeight,
      },
    })),
  });
}

export function blueGreenStrategy({
  routeId,
  healthGate,
  soakSeconds,
  reapAfterSoak = false,
}) {
  assertNonEmptyString(routeId, "blueGreen.routeId");
  if (!Number.isInteger(soakSeconds) || soakSeconds <= 0) {
    throw new Error("blueGreen.soakSeconds must be a positive integer");
  }

  const steps = [
    {
      name: "prepare-green",
      gateTiming: "after",
      gateRefs: [],
      action: {
        kind: "deployment.prepareGreen",
        routeId,
      },
    },
    {
      name: "flip-router",
      gateTiming: "before",
      gateRefs: gateRefsFor({ healthGate, autoRollbackSignals: [] }),
      action: {
        kind: "gateway.flipRoute",
        routeId,
      },
    },
    {
      name: "retain-blue",
      gateTiming: "after",
      gateRefs: [],
      action: {
        kind: "deployment.retainBlue",
        routeId,
        soakSeconds,
      },
    },
  ];

  if (reapAfterSoak) {
    steps.push({
      name: "reap-blue",
      gateTiming: "before",
      gateRefs: [{ kind: "soak", id: `${routeId}-blue-soak`, afterSeconds: soakSeconds }],
      action: {
        kind: "deployment.reapBlue",
        routeId,
      },
    });
  }

  return deepFreeze({
    kind: "deployment-strategy-template",
    strategy: "blue-green",
    routeId,
    soakSeconds,
    steps,
  });
}

export function recreateStrategy({
  routeId,
  healthGate,
}) {
  assertNonEmptyString(routeId, "recreate.routeId");

  return deepFreeze({
    kind: "deployment-strategy-template",
    strategy: "recreate",
    routeId,
    steps: [
      {
        name: "stop-blue",
        gateTiming: "after",
        gateRefs: [],
        action: {
          kind: "deployment.stopVersion",
          routeId,
        },
      },
      {
        name: "start-green",
        gateTiming: "after",
        gateRefs: [],
        action: {
          kind: "deployment.startVersion",
          routeId,
        },
      },
      {
        name: "route-green",
        gateTiming: "before",
        gateRefs: gateRefsFor({ healthGate, autoRollbackSignals: [] }),
        action: {
          kind: "gateway.shiftTraffic",
          routeId,
          toWeight: 100,
        },
      },
    ],
  });
}

export function progressiveStrategy({
  routeId,
  stages,
  autoRollbackSignals = [],
}) {
  assertNonEmptyString(routeId, "progressive.routeId");
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new Error("progressive.stages must be a non-empty array");
  }
  const parsedStages = stages.map((stage, index) => ({
    name: assertNonEmptyString(stage.name, `progressive.stages[${index}].name`),
    toWeight: parsePercentage(stage.toWeight, `progressive.stages[${index}].toWeight`),
    timeoutMs: stage.timeoutMs,
  }));
  assertEndsAtFullTraffic(
    parsedStages.map((stage) => stage.toWeight),
    "progressive.stages[].toWeight",
  );

  return deepFreeze({
    kind: "deployment-strategy-template",
    strategy: "progressive",
    routeId,
    steps: parsedStages.map((stage) => {
      return {
        name: `progressive-${stage.name}`,
        gateTiming: "after",
        gateRefs: gateRefsFor({
          healthGate: {
            id: `${stage.name}-health`,
            timeoutMs: stage.timeoutMs,
          },
          autoRollbackSignals,
        }),
        action: {
          kind: "gateway.shiftTraffic",
          routeId,
          toWeight: stage.toWeight,
        },
      };
    }),
  });
}

export function createDeploymentStrategySaga({ now = () => new Date().toISOString() } = {}) {
  return {
    async run({
      rollout,
      eventLog = [],
      gateway,
      gateSignal = () => ({ decision: "pass", reason: "healthy" }),
    }) {
      const parsed = parseRollout(rollout);
      const output = [];
      const append = (type, data) => {
        const event = createRolloutEvent({
          rollout: parsed,
          type,
          data,
          seq: nextSeq([...eventLog, ...output]),
          now,
        });
        output.push(event);
        return event;
      };

      let status = eventLog.length > 0 ? replayRollout(eventLog) : null;

      if (!status) {
        append(EVENT_TYPES.started, {
          rolloutId: parsed.rolloutId,
          target: parsed.target,
          policy: parsed.policy,
          warnings: [],
        });
        status = replayRollout(output);
      }

      if (isTerminal(status.state)) {
        return resultFor(eventLog, output);
      }

      for (let stepIndex = status.currentStepIndex; stepIndex < parsed.policy.steps.length; stepIndex += 1) {
        const step = parsed.policy.steps[stepIndex];

        if (step.gateTiming === "before") {
          const decision = await evaluateGate({ gateSignal, rollout: parsed, step, stepIndex });
          appendGate(append, parsed, step, stepIndex, decision);
          if (decision.decision !== "pass") {
            await rollback({ gateway, rollout: parsed, append, stepIndex, reason: decision.reason });
            return resultFor(eventLog, output);
          }
        }

        let actionResult;
        try {
          actionResult = await applyAction({
            gateway,
            rollout: parsed,
            step,
            stepIndex,
            eventLog: [...eventLog, ...output],
          });
        } catch (error) {
          await rollback({
            gateway,
            rollout: parsed,
            append,
            stepIndex,
            reason: error instanceof Error ? error.message : String(error),
          });
          return resultFor(eventLog, output);
        }

        if (actionResult?.status === "held") {
          appendGate(append, parsed, step, stepIndex, {
            decision: "hold",
            reason: actionResult.reason ?? `${step.name} held by gateway`,
            signals: { actionResult },
          });
          return resultFor(eventLog, output);
        }

        append(EVENT_TYPES.stepped, {
          rolloutId: parsed.rolloutId,
          stepIndex,
          step,
          state: "running",
          actionResult,
        });

        if (step.gateTiming !== "before" && step.gateRefs.length > 0) {
          const decision = await evaluateGate({ gateSignal, rollout: parsed, step, stepIndex });
          appendGate(append, parsed, step, stepIndex, decision);
          if (decision.decision !== "pass") {
            await rollback({ gateway, rollout: parsed, append, stepIndex, reason: decision.reason });
            return resultFor(eventLog, output);
          }
        }
      }

      const latest = replayRollout([...eventLog, ...output]);
      if (latest.state === "running") {
        const gatewayState = replayGatewayState([...eventLog, ...output]);
        append(EVENT_TYPES.promoted, {
          rolloutId: parsed.rolloutId,
          finalVersion: parsed.target.toVersion,
          completedSteps: parsed.policy.steps.map((step) => step.name),
          reason: "all-steps-passed",
          retainedVersion: gatewayState.retainedVersion,
          reapAfter: gatewayState.reapAfter,
        });
      }

      return resultFor(eventLog, output);
    },
  };
}

export function replayGatewayState(events) {
  let state = null;

  for (const event of events) {
    validateRolloutEvent(event);

    if (event.type === EVENT_TYPES.started) {
      state = {
        routeId: event.data.target.routeId,
        activeVersion: event.data.target.fromVersion,
        split: {
          [event.data.target.fromVersion]: 100,
          [event.data.target.toVersion]: 0,
        },
      };
      continue;
    }

    if (!state) {
      throw new Error(`gateway replay starts with ${event.type}`);
    }

    if (event.type === EVENT_TYPES.stepped) {
      state = event.data.actionResult?.state
        ? cloneJson(event.data.actionResult.state)
        : applyActionToState(state, event.data.step.action);
      continue;
    }

    if (event.type === EVENT_TYPES.rolledBack) {
      state = {
        routeId: event.data.routeId,
        activeVersion: event.data.restoredVersion,
        split: {
          [event.data.restoredVersion]: 100,
          [event.data.revertedVersion]: 0,
        },
      };
    }
  }

  if (!state) {
    throw new Error("gateway event stream is empty");
  }

  return deepFreeze(state);
}

async function applyAction({ gateway, rollout, step, stepIndex, eventLog }) {
  assertGateway(gateway);

  if (step.action.kind === "gateway.shiftTraffic") {
    return applyGatewayCommand(gateway, {
      kind: "gateway.shiftTraffic",
      routeId: step.action.routeId,
      fromVersion: rollout.target.fromVersion,
      toVersion: rollout.target.toVersion,
      toWeight: step.action.toWeight,
      idempotencyKey: `${rollout.rolloutId}:step:${stepIndex}`,
    });
  }

  if (step.action.kind === "deployment.prepareGreen") {
    return applyGatewayCommand(gateway, {
      kind: "deployment.prepareGreen",
      routeId: step.action.routeId,
      toVersion: rollout.target.toVersion,
      idempotencyKey: `${rollout.rolloutId}:step:${stepIndex}`,
    });
  }

  if (step.action.kind === "deployment.stopVersion") {
    return applyGatewayCommand(gateway, {
      kind: "deployment.stopVersion",
      routeId: step.action.routeId,
      fromVersion: rollout.target.fromVersion,
      idempotencyKey: `${rollout.rolloutId}:step:${stepIndex}`,
    });
  }

  if (step.action.kind === "deployment.startVersion") {
    return applyGatewayCommand(gateway, {
      kind: "deployment.startVersion",
      routeId: step.action.routeId,
      toVersion: rollout.target.toVersion,
      idempotencyKey: `${rollout.rolloutId}:step:${stepIndex}`,
    });
  }

  if (step.action.kind === "gateway.flipRoute") {
    return applyGatewayCommand(gateway, {
      kind: "gateway.flipRoute",
      routeId: step.action.routeId,
      fromVersion: rollout.target.fromVersion,
      toVersion: rollout.target.toVersion,
      idempotencyKey: `${rollout.rolloutId}:step:${stepIndex}`,
    });
  }

  if (step.action.kind === "deployment.retainBlue") {
    const flipCompletedAt = findLastStepTime(eventLog, "gateway.flipRoute") ?? findStartedAt(eventLog);
    return applyGatewayCommand(gateway, {
      kind: "deployment.retainBlue",
      routeId: step.action.routeId,
      retainedVersion: rollout.target.fromVersion,
      reapAfter: addSeconds(flipCompletedAt, step.action.soakSeconds),
      idempotencyKey: `${rollout.rolloutId}:step:${stepIndex}`,
    });
  }

  if (step.action.kind === "deployment.reapBlue") {
    assertBlueReapAllowed({ eventLog, rollout });
    return applyGatewayCommand(gateway, {
      kind: "deployment.reapBlue",
      routeId: step.action.routeId,
      activeVersion: rollout.target.toVersion,
      retainedVersion: rollout.target.fromVersion,
      idempotencyKey: `${rollout.rolloutId}:step:${stepIndex}`,
    });
  }

  return { status: "noop" };
}

function applyActionToState(state, action) {
  if (action.kind === "gateway.shiftTraffic") {
    return {
      routeId: action.routeId,
      activeVersion: action.toWeight === 100
        ? action.toVersion
        : state.activeVersion,
      split: {
        [action.fromVersion]: 100 - action.toWeight,
        [action.toVersion]: action.toWeight,
      },
    };
  }

  if (action.kind === "deployment.reapBlue") {
    const { retainedVersion: _retainedVersion, ...rest } = state;
    return {
      ...rest,
      reapedVersion: action.retainedVersion,
    };
  }

  return state;
}

async function rollback({ gateway, rollout, append, stepIndex, reason }) {
  assertGateway(gateway);
  const command = {
    kind: "gateway.rollbackTraffic",
    routeId: rollout.target.routeId,
    restoredVersion: rollout.target.fromVersion,
    revertedVersion: rollout.target.toVersion,
    restoredWeight: 100,
    idempotencyKey: `${rollout.rolloutId}:rollback:${stepIndex}`,
  };
  const actionResult = await gateway.apply(command);

  append(EVENT_TYPES.failed, {
    rolloutId: rollout.rolloutId,
    state: "failed",
    reason,
    dangling: false,
    stepIndex,
  });
  append(EVENT_TYPES.rolledBack, {
    rolloutId: rollout.rolloutId,
    restoredVersion: rollout.target.fromVersion,
    revertedVersion: rollout.target.toVersion,
    routeId: rollout.target.routeId,
    reason,
    stepIndex,
    actionResult,
  });
}

async function evaluateGate({ gateSignal, rollout, step, stepIndex }) {
  let decision;
  try {
    decision = await readGateSignal({ gateSignal, rollout, step, stepIndex });
  } catch (error) {
    return {
      decision: "fail",
      reason: `gate hook threw: ${error instanceof Error ? error.message : String(error)}`,
      signals: {},
    };
  }

  if (Array.isArray(decision?.healthSamples)) {
    return evaluateHealthHysteresis(decision.healthSamples, healthGateOptions(step));
  }

  if (decision?.decision === "fail") {
    return {
      decision: "fail",
      reason: decision.reason ?? "gate failed",
      signals: cloneJson(decision.signals ?? {}),
    };
  }

  if (decision?.decision === "timeout") {
    return {
      decision: "fail",
      reason: `gate timeout: ${decision.reason ?? "deadline exceeded"}`,
      signals: cloneJson(decision.signals ?? {}),
    };
  }

  if (decision?.signals) {
    const autoRollback = evaluateAutoRollbackSignals(decision.signals);
    if (autoRollback.decision === "fail") {
      return autoRollback;
    }
  }

  return {
    decision: "pass",
    reason: decision?.reason ?? "healthy",
    signals: cloneJson(decision?.signals ?? {}),
  };
}

function evaluateAutoRollbackSignals(signals) {
  const clonedSignals = cloneJson(signals ?? {});

  if (signals?.goldenSuite?.status === "failed" || (signals?.goldenSuite?.failures ?? []).length > 0) {
    return {
      decision: "fail",
      reason: "golden-suite-failure",
      signals: clonedSignals,
    };
  }

  if (signals?.sloBurn?.verdict === "rollback") {
    return {
      decision: "fail",
      reason: signals.sloBurn.reason ?? "slo-burn-rate-rollback-threshold",
      signals: clonedSignals,
    };
  }

  return {
    decision: "pass",
    reason: "auto-rollback-signals-healthy",
    signals: clonedSignals,
  };
}

function evaluateHealthHysteresis(
  samples,
  { passAfterConsecutive = 2, failAfterConsecutive = 2 } = {},
) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("health samples must be a non-empty array");
  }

  let healthyRun = 0;
  let unhealthyRun = 0;

  for (const sample of samples) {
    if (sample === "healthy" || sample?.status === "healthy") {
      healthyRun += 1;
      unhealthyRun = 0;
    } else if (sample === "unhealthy" || sample?.status === "unhealthy") {
      unhealthyRun += 1;
      healthyRun = 0;
    } else {
      throw new Error(`unsupported health sample ${JSON.stringify(sample)}`);
    }

    if (healthyRun >= passAfterConsecutive) {
      return {
        decision: "pass",
        reason: "health-hysteresis-pass",
        signals: { healthSamples: cloneJson(samples) },
      };
    }

    if (unhealthyRun >= failAfterConsecutive) {
      return {
        decision: "fail",
        reason: "health-hysteresis-fail",
        signals: { healthSamples: cloneJson(samples) },
      };
    }
  }

  return {
    decision: "fail",
    reason: "health-hysteresis-timeout",
    signals: { healthSamples: cloneJson(samples) },
  };
}

function appendGate(append, rollout, step, stepIndex, decision) {
  append(EVENT_TYPES.gateEvaluated, {
    rolloutId: rollout.rolloutId,
    stepIndex,
    step,
    decision: decision.decision,
    reason: decision.reason,
    gateRefs: step.gateRefs,
    signals: decision.signals,
  });
}

function resultFor(eventLog, output) {
  return deepFreeze({
    status: replayRollout([...eventLog, ...output]),
    events: output,
  });
}

function createRolloutEvent({ rollout, type, data, seq, now }) {
  return deepFreeze(validateRolloutEvent({
    specversion: "1.0",
    id: `${type}:${rollout.rolloutId}:${seq}`,
    source: "hobo:delivery",
    type,
    subject: rollout.rolloutId,
    runId: rollout.runId,
    tenant: rollout.tenant,
    seq,
    time: now(),
    actor: cloneJson(rollout.actor),
    data: cloneJson(data),
  }));
}

function parseRollout(rollout) {
  if (!rollout || !isJsonObject(rollout) || Array.isArray(rollout)) {
    throw new Error("rollout must be an object");
  }

  assertNonEmptyString(rollout.rolloutId, "rollout.rolloutId");
  assertNonEmptyString(rollout.runId, "rollout.runId");
  assertNonEmptyString(rollout.tenant, "rollout.tenant");
  const target = parseTarget(rollout.target);
  const strategy = parseStrategy(rollout.strategy);

  return deepFreeze({
    rolloutId: rollout.rolloutId,
    runId: rollout.runId,
    tenant: rollout.tenant,
    actor: rollout.actor ?? { kind: "system", id: "delivery-harness", tenant: rollout.tenant },
    target,
    strategy,
    policy: {
      strategy: strategy.strategy,
      steps: strategy.steps.map((step) => bindTarget(step, target)),
    },
  });
}

function parseTarget(target) {
  if (!target || !isJsonObject(target) || Array.isArray(target)) {
    throw new Error("rollout.target must be an object");
  }

  return {
    service: assertNonEmptyString(target.service, "rollout.target.service"),
    routeId: assertNonEmptyString(target.routeId, "rollout.target.routeId"),
    fromVersion: assertNonEmptyString(target.fromVersion, "rollout.target.fromVersion"),
    toVersion: assertNonEmptyString(target.toVersion, "rollout.target.toVersion"),
  };
}

function parseStrategy(strategy) {
  if (!strategy || !isJsonObject(strategy) || Array.isArray(strategy)) {
    throw new Error("rollout.strategy must be an object");
  }

  assertNonEmptyString(strategy.strategy, "rollout.strategy.strategy");
  if (!Array.isArray(strategy.steps)) {
    throw new Error("rollout.strategy.steps must be an array");
  }

  return {
    strategy: strategy.strategy,
    steps: strategy.steps.map(parseStep),
  };
}

function parseStep(step, stepIndex) {
  if (!step || !isJsonObject(step) || Array.isArray(step)) {
    throw new Error(`rollout.strategy.steps[${stepIndex}] must be an object`);
  }

  const gateTiming = step.gateTiming ?? "after";
  if (!["before", "after"].includes(gateTiming)) {
    throw new Error(`unsupported gate timing ${gateTiming}`);
  }

  return {
    name: assertNonEmptyString(step.name, `rollout.strategy.steps[${stepIndex}].name`),
    gateTiming,
    gateRefs: Array.isArray(step.gateRefs) ? cloneJson(step.gateRefs) : [],
    action: cloneJson(step.action ?? { kind: "noop" }),
  };
}

function bindTarget(step, target) {
  if (step.action.kind === "gateway.shiftTraffic") {
    return {
      ...step,
      action: {
        ...step.action,
        fromVersion: target.fromVersion,
        toVersion: target.toVersion,
      },
    };
  }

  if (
    step.action.kind === "deployment.prepareGreen" ||
    step.action.kind === "deployment.stopVersion" ||
    step.action.kind === "deployment.startVersion" ||
    step.action.kind === "gateway.flipRoute" ||
    step.action.kind === "deployment.reapBlue"
  ) {
    return {
      ...step,
      action: {
        ...step.action,
        fromVersion: target.fromVersion,
        toVersion: target.toVersion,
      },
    };
  }

  if (step.action.kind === "deployment.retainBlue") {
    return {
      ...step,
      action: {
        ...step.action,
        retainedVersion: target.fromVersion,
      },
    };
  }

  return step;
}

function gateRefsFor({ healthGate, autoRollbackSignals }) {
  const refs = [];
  if (healthGate) {
    refs.push({
      kind: "health",
      id: assertNonEmptyString(healthGate.id, "healthGate.id"),
      timeoutMs: healthGate.timeoutMs === undefined
        ? 300000
        : assertPositiveInteger(healthGate.timeoutMs, "healthGate.timeoutMs"),
      passAfterConsecutive: healthGate.passAfterConsecutive === undefined
        ? 2
        : assertPositiveInteger(healthGate.passAfterConsecutive, "healthGate.passAfterConsecutive"),
      failAfterConsecutive: healthGate.failAfterConsecutive === undefined
        ? 2
        : assertPositiveInteger(healthGate.failAfterConsecutive, "healthGate.failAfterConsecutive"),
    });
  }

  for (const signal of autoRollbackSignals) {
    refs.push({ kind: "auto-rollback-signal", signal: assertNonEmptyString(signal, "autoRollbackSignals[]") });
  }

  return refs;
}

function parsePercentages(percentages, path) {
  if (!Array.isArray(percentages) || percentages.length === 0) {
    throw new Error(`${path} must be a non-empty array`);
  }

  return percentages.map((percentage, index) => parsePercentage(percentage, `${path}[${index}]`));
}

function parsePercentage(percentage, path) {
  if (!Number.isInteger(percentage) || percentage <= 0 || percentage > 100) {
    throw new Error(`${path} must be an integer from 1 to 100`);
  }
  return percentage;
}

function assertEndsAtFullTraffic(weights, path) {
  if (weights.at(-1) !== 100) {
    throw new Error(`${path} must end at 100 before rollout promotion`);
  }
}

function nextSeq(events) {
  return events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0) + 1;
}

function healthGateOptions(step) {
  const healthGate = step.gateRefs.find((gateRef) => gateRef.kind === "health") ?? {};
  return {
    timeoutMs: healthGate.timeoutMs,
    passAfterConsecutive: healthGate.passAfterConsecutive,
    failAfterConsecutive: healthGate.failAfterConsecutive,
  };
}

async function readGateSignal({ gateSignal, rollout, step, stepIndex }) {
  const signal = Promise.resolve().then(() => gateSignal({ rollout, step, stepIndex }));
  const timeoutMs = healthGateOptions(step).timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return signal;
  }

  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(
      () => resolve({ decision: "timeout", reason: `${step.name} exceeded ${timeoutMs}ms` }),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([signal, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function applyGatewayCommand(gateway, command) {
  let result;
  let attempts = 0;

  while (attempts < 3) {
    attempts += 1;
    result = await gateway.apply(command);
    if (result?.status !== "partial") {
      return {
        status: result?.status ?? "applied",
        reason: result?.reason,
        state: cloneJson(result?.state),
        signals: cloneJson(result?.signals),
        command: cloneJson(command),
        attempts,
      };
    }
  }

  if (result?.status === "partial") {
    throw new Error(`gateway command ${command.kind} did not converge after ${attempts} attempts`);
  }

  return {
    status: result?.status ?? "applied",
    reason: result?.reason,
    state: cloneJson(result?.state),
    signals: cloneJson(result?.signals),
    command: cloneJson(command),
    attempts,
  };
}

function assertBlueReapAllowed({ eventLog, rollout }) {
  const flipGate = findLastGateForAction(eventLog, "gateway.flipRoute");
  const gatewayState = replayGatewayState(eventLog);

  if (
    !flipGate ||
    flipGate.data.decision !== "pass" ||
    gatewayState.activeVersion !== rollout.target.toVersion ||
    gatewayState.retainedVersion !== rollout.target.fromVersion
  ) {
    throw new Error("cannot reap blue before green is healthy and retained");
  }
}

function findLastGateForAction(events, actionKind) {
  return [...events]
    .reverse()
    .find((event) => event.type === EVENT_TYPES.gateEvaluated && event.data.step.action.kind === actionKind);
}

function findStartedAt(events) {
  const started = events.find((event) => event.type === EVENT_TYPES.started);
  if (!started) {
    throw new Error("rollout.Started event is required before executing steps");
  }
  return started.time;
}

function findLastStepTime(events, actionKind) {
  return [...events]
    .reverse()
    .find((event) => event.type === EVENT_TYPES.stepped && event.data.step.action.kind === actionKind)
    ?.time;
}

function addSeconds(isoTime, seconds) {
  const date = new Date(isoTime);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid time ${isoTime}`);
  }
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

function assertGateway(gateway) {
  if (!gateway || !(gateway.apply instanceof Function)) {
    throw new Error("gateway.apply(command) is required");
  }
}

function isTerminal(state) {
  return state === "promoted" || state === "rolled-back" || state === "failed";
}

function assertNonEmptyString(value, path) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string`);
  }

  return value;
}

function assertPositiveInteger(value, path) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer`);
  }

  return value;
}

function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}
