import {
  createDeploymentStrategySaga,
  canaryStrategy,
  replayGatewayState,
} from "../../../../technical-proofs/deployment-strategy-saga-templates-contract/src/deployment-strategy-saga-templates.js";
import { replayRollout } from "../../../../technical-proofs/delivery-orchestrator-skeleton-contract/src/delivery-orchestrator.js";
import {
  createHoboUpConvergence,
  sampleSnapshopProject,
} from "../../../../technical-proofs/hobo-up-convergence-contract/src/up-convergence.js";
import {
  createInspectCli,
  createInspectStore,
} from "../../../../technical-proofs/hobo-inspect-projection-contract/src/inspect-contract.js";
import {
  createGateDecision,
  evaluatePromotionGate,
  resolvePromotionPolicy,
} from "../../../../technical-proofs/slo-promotion-gate-contract/src/slo-promotion-gate-contract.js";

export const DEVOPS_CANARY_ROLLOUT_JOURNEY_VERSION = "hobo.devops-canary-rollout-journey/v1";

const NOW = "2026-06-28T09:30:00.000Z";
const TENANT = "acme";
const ROUTE_ID = "checkout-public";
const SERVICE = "checkout-api";
const DEFAULT_FROM_VERSION = "checkout@sha256:blue";
const DEFAULT_TARGET_VERSION = "checkout@sha256:green";
const DEFAULT_REVISION = "sha-good-20260628";
const ROLLOUT_ID = "rollout_checkout_canary";
const RUN_ID = "run_checkout_canary";

export async function runHealthyCanaryJourney({
  targetRevision = DEFAULT_REVISION,
  fromRevision = DEFAULT_FROM_VERSION,
  targetVersion = targetRevision.startsWith("checkout@") ? targetRevision : DEFAULT_TARGET_VERSION,
} = {}) {
  const up = await runHoboUp({ targetRevision });
  const promotionGate = createPromotionGate({
    verdictProfile: "healthy",
    rolloutId: ROLLOUT_ID,
  });
  const rollout = await runCanaryRollout({
    fromRevision,
    targetVersion,
    gateSignal: () => ({
      decision: "pass",
      reason: promotionGate.reason,
      signals: {
        sloBurn: {
          verdict: promotionGate.verdict,
          reason: promotionGate.reason,
          sourceSeq: promotionGate.sourceSeq,
        },
      },
    }),
  });
  const inspect = await inspectRollout(rollout.events);

  return journeyResult({
    command: commandFor(targetRevision),
    up,
    rollout,
    inspect,
    promotionGate: {
      verdict: promotionGate.verdict,
      reason: promotionGate.reason,
      sameGateAsDeploy: up.events.some((event) => event.type === "gate.DeployPassed"),
      decisionEvent: promotionGate.event,
    },
  });
}

export async function runSloBurnRollbackJourney({
  burnAtPercent = 50,
  fromRevision = DEFAULT_FROM_VERSION,
  targetRevision = DEFAULT_TARGET_VERSION,
} = {}) {
  const up = await runHoboUp({ targetRevision });
  const burnGate = createPromotionGate({
    verdictProfile: "burn",
    rolloutId: ROLLOUT_ID,
  });
  const rollout = await runCanaryRollout({
    fromRevision,
    targetVersion: targetRevision,
    gateSignal: ({ step }) => {
      if (step.action.toWeight === burnAtPercent) {
        return {
          decision: "pass",
          reason: "guardrail SLO burn",
          signals: {
            sloBurn: {
              verdict: burnGate.verdict,
              reason: burnGate.reason,
              sourceSeq: burnGate.sourceSeq,
              sloId: burnGate.sloId,
            },
          },
        };
      }

      return healthyGateSignal();
    },
  });
  const inspect = await inspectRollout(rollout.events);

  return journeyResult({
    command: commandFor(targetRevision),
    up,
    rollout,
    inspect,
    rollback: rollbackEvidence(rollout, burnGate.reason),
  });
}

export async function runFlappingSloScenario() {
  const rollout = await runCanaryRollout({
    fromRevision: DEFAULT_FROM_VERSION,
    targetVersion: DEFAULT_TARGET_VERSION,
    gateSignal: () => ({
      healthSamples: ["healthy", "unhealthy", "healthy", "unhealthy", "healthy"],
    }),
  });

  return {
    contractVersion: DEVOPS_CANARY_ROLLOUT_JOURNEY_VERSION,
    rollout: rolloutSummary(rollout),
    gatewayCommands: rollout.gateway.commands,
    hysteresis: {
      minConsecutiveSamples: 2,
      minDwellSeconds: 120,
      rollbackCommands: countCommands(rollout.gateway.commands, "gateway.rollbackTraffic"),
      promoteCommands: rollout.events.filter((event) => event.type === "rollout.Promoted").length,
    },
  };
}

export async function runAbortedRolloutScenario({ abortAtPercent = 50 } = {}) {
  const rollout = await runCanaryRollout({
    fromRevision: DEFAULT_FROM_VERSION,
    targetVersion: DEFAULT_TARGET_VERSION,
    gateSignal: ({ step }) => {
      if (step.action.toWeight === abortAtPercent) {
        return { decision: "fail", reason: "operator-aborted" };
      }

      return healthyGateSignal();
    },
  });
  const inspect = await inspectRollout(rollout.events);
  const reconstructed = reconstructRolloutState(rollout.events);

  return {
    contractVersion: DEVOPS_CANARY_ROLLOUT_JOURNEY_VERSION,
    rollout: rolloutSummary(rollout),
    rollback: rollbackEvidence(rollout, "operator-aborted"),
    halfPromoted: rollout.events.some((event) => event.type === "rollout.Promoted"),
    reconstructed,
    inspect,
  };
}

export async function runUnhealthyFirstStepScenario() {
  const rollout = await runCanaryRollout({
    fromRevision: DEFAULT_FROM_VERSION,
    targetVersion: DEFAULT_TARGET_VERSION,
    gateSignal: ({ step }) => {
      if (step.action.toWeight === 10) {
        return { healthSamples: ["unhealthy", "unhealthy"] };
      }

      return healthyGateSignal();
    },
  });

  return {
    contractVersion: DEVOPS_CANARY_ROLLOUT_JOURNEY_VERSION,
    rollout: rolloutSummary(rollout),
    gatewayCommands: rollout.gateway.commands,
  };
}

export function reconstructRolloutState(events) {
  return {
    status: replayRollout(events),
    gatewayState: replayGatewayState(events),
    trafficSteps: trafficSteps(events),
  };
}

async function runHoboUp({ targetRevision }) {
  const up = createHoboUpConvergence({
    now: () => NOW,
    idFactory: deterministicIds(),
    evaluateGate: ({ revision }) => {
      if (revision.revision !== targetRevision) {
        return {
          status: "failed",
          code: "revision.mismatch",
          reason: `expected ${targetRevision}, got ${revision.revision}`,
          fix: "rerun hobo up with the selected known-good revision",
        };
      }

      return { status: "passed", gateId: "prod-promotion:passed" };
    },
  });

  return up.run({
    project: sampleSnapshopProject({
      currentRevision: targetRevision,
      defaultCampId: "prod",
    }),
    flags: {
      camp: "prod",
      strategy: "canary",
      to: targetRevision,
      json: true,
    },
  });
}

async function runCanaryRollout({
  fromRevision,
  targetVersion,
  gateSignal,
}) {
  const gateway = recordingGateway({ fromRevision, targetVersion });
  const saga = createDeploymentStrategySaga({ now: fixedClock() });
  const result = await saga.run({
    rollout: rolloutWith({
      fromRevision,
      targetVersion,
      strategy: declaredCanaryStrategy(),
    }),
    gateway,
    gateSignal,
  });

  return {
    ...result,
    gateway,
  };
}

function journeyResult({
  command,
  up,
  rollout,
  inspect,
  promotionGate = null,
  rollback = null,
}) {
  return {
    contractVersion: DEVOPS_CANARY_ROLLOUT_JOURNEY_VERSION,
    command,
    declaredRollout: declaredRollout(),
    up: {
      status: up.status,
      revision: up.revision,
      events: up.events,
    },
    rollout: rolloutSummary(rollout),
    inspect,
    logs: rolloutLogs(rollout.events),
    audit: {
      eventCount: rollout.events.length,
      events: rollout.events,
    },
    ...(promotionGate ? { promotionGate } : undefined),
    ...(rollback ? { rollback } : undefined),
    scopeOut: {
      flagExperimentHarnessImplemented: false,
      sloMetricPipelineImplemented: false,
      rolloutControllerInternalsImplemented: false,
      manualBlueGreenToolingImplemented: false,
    },
  };
}

function rolloutSummary(rollout) {
  return {
    status: rollout.status,
    trafficSteps: trafficSteps(rollout.events),
    healthChecks: healthChecks(rollout.events),
    gatewayState: replayGatewayState(rollout.events),
  };
}

function rollbackEvidence(rollout, trigger) {
  const rolledBack = rollout.events.find((event) => event.type === "rollout.RolledBack");
  const gatewayState = replayGatewayState(rollout.events);

  return {
    trigger,
    humanActionRequired: false,
    targetRevision: rolledBack.data.restoredVersion,
    revertedRevision: rolledBack.data.revertedVersion,
    gatewayState,
    strandedTraffic: Object.entries(gatewayState.split)
      .some(([version, weight]) => version !== rolledBack.data.restoredVersion && weight !== 0),
  };
}

function declaredRollout() {
  return {
    source: "delivery/rollout.ts",
    expression: 'rollout("api", { strategy: "canary", steps: ["10%", "50%", "100%"], rollbackOn: "slo:checkout.latency" })',
    strategy: "canary",
    steps: ["10%", "50%", "100%"],
    rollbackOn: "slo:checkout.latency",
  };
}

function declaredCanaryStrategy() {
  return canaryStrategy({
    routeId: ROUTE_ID,
    percentages: [10, 50, 100],
    healthGate: {
      id: "slo:checkout.latency",
      timeoutMs: 300000,
      passAfterConsecutive: 2,
      failAfterConsecutive: 2,
    },
    autoRollbackSignals: ["slo:checkout.latency"],
  });
}

function rolloutWith({ fromRevision, targetVersion, strategy }) {
  return {
    rolloutId: ROLLOUT_ID,
    runId: RUN_ID,
    tenant: TENANT,
    actor: { kind: "service-account", id: "delivery-harness", tenant: TENANT },
    target: {
      service: SERVICE,
      routeId: ROUTE_ID,
      fromVersion: fromRevision,
      toVersion: targetVersion,
    },
    strategy,
  };
}

function createPromotionGate({ verdictProfile, rolloutId }) {
  const burnRate = verdictProfile === "burn" ? 18 : 1;
  const resolved = resolvePromotionPolicy(
    {
      id: "prod-canary-promotion",
      gates: [
        {
          sloId: "checkout.latency",
          analysisWindow: "5m",
          thresholds: {
            holdBurnRate: 4,
            rollbackBurnRate: 12,
            minRemainingBudgetRatio: 0.1,
          },
        },
      ],
    },
    {
      seq: verdictProfile === "burn" ? 42 : 41,
      generatedAt: NOW,
      slos: [
        {
          id: "checkout.latency",
          burnRate,
          remainingBudgetRatio: verdictProfile === "burn" ? 0.08 : 0.82,
          status: "available",
        },
      ],
    },
  );
  const verdict = evaluatePromotionGate(resolved);
  const event = createGateDecision(resolved, {
    decisionId: `gate:${verdictProfile}`,
    rolloutId,
  });

  return {
    verdict: verdict.verdict,
    reason: verdict.reason,
    sloId: verdict.sloId ?? "checkout.latency",
    sourceSeq: resolved.seq,
    event,
  };
}

function healthyGateSignal() {
  return {
    decision: "pass",
    reason: "within-slo-budget",
    signals: {
      sloBurn: {
        verdict: "promote",
        reason: "within-slo-budget",
        sourceSeq: 41,
      },
    },
  };
}

async function inspectRollout(events) {
  const store = createInspectStore(rolloutInspectEvents(events));
  const cli = createInspectCli({ store });
  const result = await cli.run(["run", RUN_ID, "--json"]);
  const parsed = result.stdout ? JSON.parse(result.stdout) : null;

  return {
    exitCode: result.exitCode,
    stderr: result.stderr,
    view: parsed?.view ?? null,
    at: parsed?.at ?? null,
    source: parsed?.source ?? null,
  };
}

function rolloutInspectEvents(events) {
  const mapped = [];
  let seq = 1;
  mapped.push(runInspectEvent(seq++, "run.Started", { runId: RUN_ID }));

  for (const event of events) {
    if (event.type === "rollout.Stepped") {
      mapped.push(runInspectEvent(seq++, "run.StepCompleted", {
        runId: RUN_ID,
        name: `shift-${event.data.step.name}`,
        attempts: event.data.actionResult?.attempts ?? 1,
        durationMs: 10,
      }));
    }

    if (event.type === "rollout.GateEvaluated") {
      mapped.push(runInspectEvent(seq++, "run.StepCompleted", {
        runId: RUN_ID,
        name: `health-${event.data.step.name}`,
        attempts: 1,
        durationMs: 20,
      }));
    }

    if (event.type === "rollout.RolledBack") {
      mapped.push(runInspectEvent(seq++, "run.StepCompleted", {
        runId: RUN_ID,
        name: "rollback",
        attempts: 1,
        durationMs: 5,
      }));
      mapped.push(runInspectEvent(seq++, "run.Completed", { runId: RUN_ID }));
    }

    if (event.type === "rollout.Promoted") {
      mapped.push(runInspectEvent(seq++, "run.Completed", { runId: RUN_ID }));
    }
  }

  return mapped;
}

function rolloutLogs(events) {
  return events.flatMap((event) => {
    if (event.type === "rollout.Stepped") {
      return [{
        seq: event.seq,
        message: `rollout ${event.data.step.name} shifted traffic to ${event.data.step.action.toWeight}%`,
      }];
    }

    if (event.type === "rollout.GateEvaluated") {
      return [{
        seq: event.seq,
        message: `rollout ${event.data.step.name} health ${event.data.decision}: ${event.data.reason}`,
      }];
    }

    if (event.type === "rollout.Promoted") {
      return [{
        seq: event.seq,
        message: `rollout promoted ${event.data.finalVersion}`,
      }];
    }

    if (event.type === "rollout.RolledBack") {
      return [{
        seq: event.seq,
        message: `rollout rolled back ${event.data.revertedVersion} to ${event.data.restoredVersion}`,
      }];
    }

    return [];
  });
}

function trafficSteps(events) {
  return events
    .filter((event) => event.type === "rollout.Stepped")
    .map((event) => event.data.step.action.toWeight);
}

function healthChecks(events) {
  return events
    .filter((event) => event.type === "rollout.GateEvaluated")
    .map((event) => ({
      step: event.data.step.action.toWeight,
      decision: event.data.decision,
      reason: event.data.reason,
      signals: event.data.signals ?? {},
    }));
}

function commandFor(targetRevision) {
  return `hobo up --camp prod --strategy canary --to ${targetRevision}`;
}

function countCommands(commands, kind) {
  return commands.filter((command) => command.kind === kind).length;
}

function runInspectEvent(seq, type, data) {
  return {
    seq,
    type,
    streamId: `run:${data.runId}`,
    data,
  };
}

function recordingGateway({ fromRevision, targetVersion }) {
  return {
    state: {
      routeId: ROUTE_ID,
      activeVersion: fromRevision,
      split: {
        [fromRevision]: 100,
        [targetVersion]: 0,
      },
    },
    commands: [],
    async apply(command) {
      this.commands.push(clone(command));

      if (command.kind === "gateway.shiftTraffic") {
        this.state = {
          routeId: command.routeId,
          activeVersion: command.toWeight === 100 ? command.toVersion : command.fromVersion,
          split: {
            [command.fromVersion]: 100 - command.toWeight,
            [command.toVersion]: command.toWeight,
          },
        };
        return { status: "applied", state: clone(this.state) };
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
        return { status: "applied", state: clone(this.state) };
      }

      throw new Error(`unexpected gateway command ${command.kind}`);
    },
  };
}

function fixedClock() {
  let tick = 0;
  return () => `2026-06-28T09:${String(30 + tick++).padStart(2, "0")}:00.000Z`;
}

function deterministicIds() {
  let next = 1;
  return (prefix) => `${prefix}-${next++}`;
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}
