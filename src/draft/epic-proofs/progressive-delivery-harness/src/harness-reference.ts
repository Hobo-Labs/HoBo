import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export const CONTRACT_BOUNDARIES = [
  { id: "flag-provider", pactFile: "pact-harness-flag-provider.json" },
  { id: "ruleset-sync", pactFile: "pact-harness-ruleset-sync.json" },
  { id: "policy-gate", pactFile: "pact-harness-policy-gate.json" },
  { id: "traffic-split", pactFile: "pact-harness-traffic-split.json" },
  { id: "slo-telemetry", pactFile: "pact-harness-slo-telemetry.json" },
  { id: "experiment-analytics", pactFile: "pact-harness-experiment-analytics.json" },
  { id: "event-stream", pactFile: "pact-harness-event-stream.json" },
  { id: "rollback-compensation", pactFile: "pact-harness-rollback-compensation.json" },
];

const fixtureUrl = new URL("../simulation/fixtures/progressive-delivery-fixture.json", import.meta.url);

export async function loadScenarioFixture(url = fixtureUrl) {
  return JSON.parse(await readFile(url, "utf8"));
}

export function createProgressiveDeliveryHarness(scenario) {
  const auditEvents = [];
  const trafficSplits = [];

  function record(eventType, data = {}) {
    auditEvents.push(eventType);
    return { type: eventType, data };
  }

  function evaluateFlag(request = {}) {
    const flagKey = request.flagKey ?? scenario.flag.key;
    const defaultValue = request.defaultValue ?? scenario.flag.defaultValue;
    const freshness = scenario.ruleset.freshness;
    const flag = scenario.flag.key === flagKey ? scenario.flag : null;
    const value = freshness.status === "fresh" && flag ? flag.value : defaultValue;
    record("flag.Evaluated", { flagKey, value, freshness });
    return {
      flagKey,
      value,
      variant: value,
      reason: freshness.status === "fresh" ? "targeting-match" : "fail-safe-default",
      rulesetSeq: scenario.ruleset.seq,
      freshness,
    };
  }

  function resolveRuleset() {
    return {
      seq: scenario.ruleset.seq,
      freshness: scenario.ruleset.freshness,
    };
  }

  function decidePolicy(request = {}) {
    const effect = request.action === "flag.flip" ? scenario.policy.flagFlipEffect : scenario.policy.rolloutEffect;
    const obligations = effect === "allow" ? [] : [{ id: "approval-required", status: "open" }];
    record("policy.Decided", { action: request.action, effect, obligations });
    return { effect, obligations };
  }

  function applyTrafficSplit(request = {}) {
    const percent = request.percent ?? 0;
    const observedPercent = scenario.traffic.observedByStep?.[String(percent)] ?? percent;
    trafficSplits.push(observedPercent);
    record("rollout.Stepped", { percent, observedPercent });
    return {
      requestedPercent: percent,
      observedPercent,
      converged: observedPercent === percent,
    };
  }

  function readSloSnapshot(request = {}) {
    const stepIndex = request.stepIndex ?? 0;
    const snapshot = scenario.slo.snapshots[Math.min(stepIndex, scenario.slo.snapshots.length - 1)];
    return {
      snapshotSeq: snapshot.seq,
      verdict: snapshot.verdict,
      reason: snapshot.reason,
      burnRate: snapshot.burnRate,
    };
  }

  function analyzeExperiment() {
    const experiment = scenario.experiment;
    record("experiment.Assigned", { experimentKey: experiment.key, variant: experiment.variant });
    record("experiment.Exposed", { experimentKey: experiment.key, variant: experiment.variant });

    if (!experiment.scheduledLook) {
      return { verdict: "do-not-conclude", reason: "missing-analysis-schedule", sampleSize: experiment.sampleSize };
    }

    if (experiment.sampleSize < experiment.minSampleSize) {
      return { verdict: "do-not-conclude", reason: "underpowered", sampleSize: experiment.sampleSize };
    }

    if (experiment.guardrailRegressed) {
      return { verdict: "do-not-ship", reason: "guardrail-regression", sampleSize: experiment.sampleSize };
    }

    record("experiment.Concluded", { experimentKey: experiment.key, verdict: experiment.verdict });
    return { verdict: experiment.verdict, reason: "powered", sampleSize: experiment.sampleSize };
  }

  function emitEvent(request = {}) {
    record(request.eventType, request.body ?? {});
    return { accepted: true, eventType: request.eventType };
  }

  function compensateRollback(request = {}) {
    const mode = request.mode ?? scenario.rollback.mode;
    record("policy.ObligationCreated", { reason: request.reason ?? "rollback" });

    if (mode === "fail") {
      record("rollout.NeedsHuman", { reason: "rollback-compensation-exhausted" });
      return {
        obligation: { status: "escalated" },
        status: "needs-human",
        completedSteps: ["freeze-rollout"],
        incompleteSteps: ["reset-traffic-split"],
      };
    }

    applyTrafficSplit({ percent: 0 });
    record("policy.ObligationSatisfied", { reason: request.reason ?? "rollback" });
    record("rollout.RolledBack", { reason: request.reason ?? "rollback" });
    return {
      obligation: { status: "satisfied" },
      status: "rolled_back",
      completedSteps: ["reset-traffic-split"],
      incompleteSteps: [],
    };
  }

  async function verifyBoundary(boundaryId, request) {
    switch (boundaryId) {
      case "flag-provider":
        return evaluateFlag(request);
      case "ruleset-sync":
        return resolveRuleset(request);
      case "policy-gate":
        return decidePolicy(request);
      case "traffic-split":
        return applyTrafficSplit(request);
      case "slo-telemetry":
        return readSloSnapshot(request);
      case "experiment-analytics":
        return analyzeExperiment(request);
      case "event-stream":
        return emitEvent(request);
      case "rollback-compensation":
        return compensateRollback(request);
      default:
        throw new Error(`Unknown boundary: ${boundaryId}`);
    }
  }

  return {
    scenario,
    auditEvents,
    trafficSplits,
    evaluateFlag,
    resolveRuleset,
    decidePolicy,
    applyTrafficSplit,
    readSloSnapshot,
    analyzeExperiment,
    emitEvent,
    compensateRollback,
    verifyBoundary,
  };
}

export async function runHarnessScenario(scenario) {
  const harness = createProgressiveDeliveryHarness(scenario);
  const flagEvaluation = harness.evaluateFlag({
    flagKey: scenario.flag.key,
    defaultValue: scenario.flag.defaultValue,
  });

  if (flagEvaluation.freshness.status !== "fresh") {
    return summarize(harness, {
      status: "held",
      holdReason: "stale-ruleset",
      flag: { evaluation: flagEvaluation },
      rollout: { trafficSplits: harness.trafficSplits },
      experiment: { verdict: "not-run", reason: "stale-ruleset" },
      rollback: null,
    });
  }

  const policyDecision = harness.decidePolicy({ action: "flag.flip", flagKey: scenario.flag.key });
  if (policyDecision.effect !== "allow") {
    return summarize(harness, {
      status: "held",
      holdReason: "policy-denied",
      flag: { evaluation: flagEvaluation },
      rollout: { trafficSplits: harness.trafficSplits },
      experiment: { verdict: "not-run", reason: "policy-denied" },
      rollback: null,
    });
  }

  harness.emitEvent({ eventType: "rollout.Started", body: { rolloutId: scenario.rollout.id } });

  for (const [stepIndex, percent] of scenario.rollout.steps.entries()) {
    const split = harness.applyTrafficSplit({ percent });
    if (!split.converged) {
      return summarize(harness, {
        status: "needs-human",
        flag: { evaluation: flagEvaluation },
        rollout: {
          trafficSplits: harness.trafficSplits,
          convergence: "traffic-split-not-converged",
        },
        experiment: { verdict: "not-run", reason: "rollout-not-converged" },
        rollback: { obligation: { status: "not-created" } },
      });
    }

    const slo = harness.readSloSnapshot({ stepIndex });
    if (slo.verdict === "rollback") {
      const rollback = harness.compensateRollback({ reason: slo.reason, mode: scenario.rollback.mode });
      const status = rollback.status === "needs-human" ? "needs-human" : "rolled_back";
      return summarize(harness, {
        status,
        flag: { evaluation: flagEvaluation },
        rollout: { trafficSplits: harness.trafficSplits },
        experiment: { verdict: "not-run", reason: "rolled-back" },
        rollback: { ...rollback, reason: slo.reason },
      });
    }

    if (slo.verdict === "hold") {
      return summarize(harness, {
        status: "held",
        holdReason: slo.reason,
        flag: { evaluation: flagEvaluation },
        rollout: { trafficSplits: harness.trafficSplits },
        experiment: { verdict: "not-run", reason: "slo-hold" },
        rollback: null,
      });
    }
  }

  harness.emitEvent({ eventType: "rollout.Promoted", body: { rolloutId: scenario.rollout.id } });
  const experiment = harness.analyzeExperiment();

  return summarize(harness, {
    status: "promoted",
    flag: { evaluation: flagEvaluation },
    rollout: { trafficSplits: harness.trafficSplits },
    experiment,
    rollback: null,
  });
}

export async function verifyPactContracts(harness) {
  const verified = [];

  for (const boundary of CONTRACT_BOUNDARIES) {
    const pact = JSON.parse(
      await readFile(new URL(`../contracts/pacts/${boundary.pactFile}`, import.meta.url), "utf8"),
    );
    const interaction = pact.interactions[0];
    const actualBody = await harness.verifyBoundary(boundary.id, interaction.request.body);
    assert.deepEqual(actualBody, interaction.response.body);
    verified.push({ id: boundary.id, pactFile: boundary.pactFile, status: "verified" });
  }

  return { status: "verified", boundaries: verified };
}

function summarize(harness, result) {
  return {
    ...result,
    auditEvents: [...new Set(harness.auditEvents)],
  };
}
