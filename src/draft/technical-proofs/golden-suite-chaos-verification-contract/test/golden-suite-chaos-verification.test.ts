import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  GOLDEN_CHAOS_EVENT_TYPES,
  SUPPORTED_FAULT_INJECTORS,
  evaluateGoldenSuiteChaosTier,
  replayGoldenChaosTier,
} from "../src/golden-suite-chaos-verification.js";

describe("Golden Suites + chaos verification contract", () => {
  it("passes runtime-local and Camp CI node-loss when the deploy SLO invariant holds", () => {
    const result = evaluateGoldenSuiteChaosTier({
      suite: goldenSuite(),
      goldenRuns: [
        passedRun("runtime-local", "2026-06-28T06:00:00.000Z"),
        passedRun("camp", "2026-06-28T06:01:00.000Z"),
      ],
      sloStatus: healthyDeploySlo(),
      chaosExperiment: nodeLossExperiment({
        observedResumeMs: 122_000,
        targetResumeMs: 180_000,
      }),
      policyBudget: allowCiBudget(),
      now: fixedClock("2026-06-28T06:02:00.000Z"),
    });

    assert.equal(result.status, "passed");
    assert.equal(result.decision.effect, "allow-continue");
    assert.deepEqual(result.coverage.requiredTargets, ["runtime-local", "camp"]);
    assert.deepEqual(result.coverage.satisfiedTargets, ["runtime-local", "camp"]);
    assert.deepEqual(
      result.events.map((event) => event.type),
      [
        GOLDEN_CHAOS_EVENT_TYPES.suiteRan,
        GOLDEN_CHAOS_EVENT_TYPES.suitePassed,
        GOLDEN_CHAOS_EVENT_TYPES.policyDecided,
        GOLDEN_CHAOS_EVENT_TYPES.experimentStarted,
        GOLDEN_CHAOS_EVENT_TYPES.faultInjected,
        GOLDEN_CHAOS_EVENT_TYPES.steadyStateChecked,
        GOLDEN_CHAOS_EVENT_TYPES.injectorRemoved,
        GOLDEN_CHAOS_EVENT_TYPES.experimentCompleted,
      ],
    );
    assert.equal(result.events.at(-1).data.result, "steady-state-held");
  });

  it("aborts node-loss chaos when the steady-state SLO resume target is breached", () => {
    const result = evaluateGoldenSuiteChaosTier({
      suite: goldenSuite(),
      goldenRuns: [passedRun("runtime-local"), passedRun("camp")],
      sloStatus: healthyDeploySlo(),
      chaosExperiment: nodeLossExperiment({
        observedResumeMs: 241_000,
        targetResumeMs: 180_000,
      }),
      policyBudget: allowCiBudget(),
      now: fixedClock(),
    });

    assert.equal(result.status, "aborted");
    assert.equal(result.decision.effect, "abort");
    assert.equal(result.decision.reason, "steady-state-slo-invariant-breached");
    assert.equal(result.events.at(-1).type, GOLDEN_CHAOS_EVENT_TYPES.experimentAborted);
    assert.equal(result.events.at(-1).data.reason, "steady-state-slo-invariant-breached");
    assert.deepEqual(result.events.at(-1).data.blastRadius, nodeLossExperiment().blastRadius);
  });

  it("requires auto-rollback when a non-flaky Golden-suite failure composes with SLO burn", () => {
    const result = evaluateGoldenSuiteChaosTier({
      suite: goldenSuite(),
      goldenRuns: [
        failedRun("runtime-local", { checkId: "deploy-resumes" }),
        passedRun("camp"),
      ],
      sloStatus: burningDeploySlo(),
      chaosExperiment: nodeLossExperiment(),
      policyBudget: allowCiBudget(),
      now: fixedClock(),
    });

    assert.equal(result.status, "rollback-required");
    assert.equal(result.decision.effect, "require-auto-rollback");
    assert.equal(result.decision.reason, "golden-suite-failed-while-slo-budget-burning");
    assert.equal(result.events.at(-1).type, GOLDEN_CHAOS_EVENT_TYPES.autoRollbackRequired);
    assert.equal(result.events.at(-1).data.failedChecks[0].checkId, "deploy-resumes");
    assert.ok(!result.events.some((event) => event.type === GOLDEN_CHAOS_EVENT_TYPES.faultInjected));
  });

  it("fails CI coverage when the suite did not run against both runtime-local and Camp", () => {
    const result = evaluateGoldenSuiteChaosTier({
      suite: goldenSuite(),
      goldenRuns: [passedRun("runtime-local")],
      sloStatus: healthyDeploySlo(),
      chaosExperiment: nodeLossExperiment(),
      policyBudget: allowCiBudget(),
      now: fixedClock(),
    });

    assert.equal(result.status, "failed");
    assert.equal(result.decision.effect, "hold-ci");
    assert.deepEqual(result.coverage.missingTargets, ["camp"]);
    assert.equal(result.events.at(-1).data.reason, "missing-required-golden-targets");
  });

  it("denies prod chaos before fault injection when error budget or blast radius would be exceeded", () => {
    const result = evaluateGoldenSuiteChaosTier({
      suite: goldenSuite(),
      goldenRuns: [passedRun("runtime-local"), passedRun("camp")],
      sloStatus: healthyDeploySlo(),
      chaosExperiment: nodeLossExperiment({
        environment: "prod",
        blastRadius: {
          tenant: "tenant-a",
          camp: "camp-prod",
          environment: "prod",
          maxResources: 3,
          resources: ["node-a", "node-b", "node-c"],
        },
        projectedErrorBudgetCostRatio: 0.04,
      }),
      policyBudget: allowProdBudget({
        remainingErrorBudgetRatio: 0.03,
        maxBlastRadius: {
          tenant: "tenant-a",
          camp: "camp-prod",
          maxResources: 2,
        },
      }),
      now: fixedClock(),
    });

    assert.equal(result.status, "denied");
    assert.equal(result.decision.effect, "deny");
    assert.equal(result.decision.reason, "prod-chaos-policy-budget-exceeded");
    assert.deepEqual(
      result.events.map((event) => event.type),
      [
        GOLDEN_CHAOS_EVENT_TYPES.suiteRan,
        GOLDEN_CHAOS_EVENT_TYPES.suitePassed,
        GOLDEN_CHAOS_EVENT_TYPES.policyDecided,
      ],
    );
  });

  it("fails closed before prod injection when the policy budget shape is incomplete", () => {
    const result = evaluateGoldenSuiteChaosTier({
      suite: goldenSuite(),
      goldenRuns: [passedRun("runtime-local"), passedRun("camp")],
      sloStatus: healthyDeploySlo(),
      chaosExperiment: nodeLossExperiment({
        environment: "prod",
        blastRadius: {
          tenant: "tenant-a",
          camp: "camp-prod",
          environment: "prod",
          maxResources: 1,
          resources: ["node-a"],
        },
      }),
      policyBudget: allowProdBudget({ maxExperimentCostRatio: undefined }),
      now: fixedClock(),
    });

    assert.equal(result.status, "denied");
    assert.equal(result.decision.effect, "deny");
    assert.equal(result.decision.reason, "missing-chaos-policy-budget");
    assert.ok(!result.events.some((event) => event.type === GOLDEN_CHAOS_EVENT_TYPES.faultInjected));
  });

  it("hard-aborts when observed blast radius leaks beyond the declared bound", () => {
    const result = evaluateGoldenSuiteChaosTier({
      suite: goldenSuite(),
      goldenRuns: [passedRun("runtime-local"), passedRun("camp")],
      sloStatus: healthyDeploySlo(),
      chaosExperiment: nodeLossExperiment({
        observedBlastRadius: {
          tenant: "tenant-a",
          camp: "camp-ci",
          environment: "ci",
          maxResources: 2,
          resources: ["node-a", "node-b"],
        },
      }),
      policyBudget: allowCiBudget(),
      now: fixedClock(),
    });

    assert.equal(result.status, "aborted");
    assert.equal(result.decision.reason, "blast-radius-bound-leaked");
    assert.equal(result.events.at(-1).type, GOLDEN_CHAOS_EVENT_TYPES.experimentAborted);
    assert.equal(result.events.at(-1).data.observedBlastRadius.maxResources, 2);
  });

  it("dead-man aborts before injection when the abort condition cannot fire", () => {
    const result = evaluateGoldenSuiteChaosTier({
      suite: goldenSuite(),
      goldenRuns: [passedRun("runtime-local"), passedRun("camp")],
      sloStatus: healthyDeploySlo(),
      chaosExperiment: nodeLossExperiment({
        abortCondition: {
          invariant: "deploy-resumes-under-target",
          armed: false,
        },
      }),
      policyBudget: allowCiBudget(),
      now: fixedClock(),
    });

    assert.equal(result.status, "aborted");
    assert.equal(result.decision.reason, "abort-condition-deadman");
    assert.ok(!result.events.some((event) => event.type === GOLDEN_CHAOS_EVENT_TYPES.faultInjected));
  });

  it("pins the required fault injector kinds and rejects undeclared faults", () => {
    assert.deepEqual(SUPPORTED_FAULT_INJECTORS, [
      "provider-429",
      "provider-503",
      "node-loss",
      "partition",
      "latency",
      "severed-link",
    ]);
    assert.throws(
      () =>
        evaluateGoldenSuiteChaosTier({
          suite: goldenSuite(),
          goldenRuns: [passedRun("runtime-local"), passedRun("camp")],
          sloStatus: healthyDeploySlo(),
          chaosExperiment: nodeLossExperiment({
            fault: {
              kind: "cpu-burn",
              target: "node:runner-a",
              durationMs: 120_000,
            },
          }),
          policyBudget: allowCiBudget(),
          now: fixedClock(),
        }),
      /unsupported chaosExperiment\.fault\.kind: cpu-burn/,
    );
  });

  it("quarantines flaky Golden-suite failures instead of triggering spurious rollback", () => {
    const result = evaluateGoldenSuiteChaosTier({
      suite: goldenSuite({ minConfidence: 0.8 }),
      goldenRuns: [
        failedRun("runtime-local", {
          checkId: "deploy-resumes",
          confidence: 0.42,
          flaky: true,
        }),
        passedRun("camp"),
      ],
      sloStatus: burningDeploySlo(),
      chaosExperiment: nodeLossExperiment(),
      policyBudget: allowCiBudget(),
      now: fixedClock(),
    });

    assert.equal(result.status, "quarantined");
    assert.equal(result.decision.effect, "quarantine");
    assert.equal(result.events.at(-1).type, GOLDEN_CHAOS_EVENT_TYPES.suiteQuarantined);
    assert.ok(!result.events.some((event) => event.type === GOLDEN_CHAOS_EVENT_TYPES.autoRollbackRequired));
  });

  it("fails closed when the fault injector cannot be cleanly removed", () => {
    const result = evaluateGoldenSuiteChaosTier({
      suite: goldenSuite(),
      goldenRuns: [passedRun("runtime-local"), passedRun("camp")],
      sloStatus: healthyDeploySlo(),
      chaosExperiment: nodeLossExperiment({
        cleanup: {
          status: "failed",
          reason: "node-loss lease still active",
        },
      }),
      policyBudget: allowCiBudget(),
      now: fixedClock(),
    });

    assert.equal(result.status, "cleanup-failed");
    assert.equal(result.decision.effect, "abort");
    assert.equal(result.events.at(-1).type, GOLDEN_CHAOS_EVENT_TYPES.cleanupFailed);
    assert.equal(replayGoldenChaosTier(result.events).status, "cleanup-failed");
  });
});

function goldenSuite(overrides = {}) {
  return {
    id: "deploy-golden-suite",
    requiredTargets: ["runtime-local", "camp"],
    minConfidence: 0.75,
    ...overrides,
  };
}

function passedRun(targetKind, completedAt = "2026-06-28T06:00:00.000Z") {
  return {
    runId: `run-${targetKind}`,
    targetKind,
    completedAt,
    checks: [
      {
        checkId: "deploy-resumes",
        status: "passed",
        confidence: 0.99,
      },
    ],
  };
}

function failedRun(targetKind, check = {}) {
  return {
    runId: `run-${targetKind}-failed`,
    targetKind,
    completedAt: "2026-06-28T06:00:00.000Z",
    checks: [
      {
        checkId: check.checkId ?? "deploy-resumes",
        status: "failed",
        confidence: check.confidence ?? 0.98,
        flaky: check.flaky ?? false,
      },
    ],
  };
}

function healthyDeploySlo() {
  return {
    sloName: "deploy-success-rate",
    healthy: true,
    status: "healthy",
    objectiveWindow: {
      burnRate: 0.1,
      remainingBudgetRatio: 0.87,
    },
    violatedThresholds: [],
  };
}

function burningDeploySlo() {
  return {
    sloName: "deploy-success-rate",
    healthy: false,
    status: "burning",
    objectiveWindow: {
      burnRate: 3.2,
      remainingBudgetRatio: 0.14,
    },
    violatedThresholds: [
      {
        name: "slow-burn",
        burnRate: 3.2,
        remainingBudgetRatio: 0.14,
      },
    ],
  };
}

function nodeLossExperiment(overrides = {}) {
  return {
    id: "node-loss-deploy-resume",
    fault: overrides.fault ?? {
      kind: "node-loss",
      target: "node:runner-a",
      durationMs: 120_000,
    },
    steadyState: {
      invariant: "deploy-resumes-under-target",
      targetResumeMs: overrides.targetResumeMs ?? 180_000,
      observedResumeMs: overrides.observedResumeMs ?? 119_000,
    },
    blastRadius: overrides.blastRadius ?? {
      tenant: "tenant-a",
      camp: "camp-ci",
      environment: overrides.environment ?? "ci",
      maxResources: 1,
      resources: ["node-a"],
    },
    abortCondition: overrides.abortCondition ?? {
      invariant: "deploy-resumes-under-target",
      armed: true,
    },
    projectedErrorBudgetCostRatio: overrides.projectedErrorBudgetCostRatio ?? 0.005,
    observedBlastRadius: overrides.observedBlastRadius,
    cleanup: overrides.cleanup ?? {
      status: "removed",
    },
  };
}

function allowCiBudget() {
  return {
    id: "ci-chaos-budget",
    environments: ["ci"],
    remainingFaults: 10,
    remainingErrorBudgetRatio: 1,
    maxExperimentCostRatio: 0.25,
    maxBlastRadius: {
      tenant: "tenant-a",
      camp: "camp-ci",
      maxResources: 1,
    },
  };
}

function allowProdBudget(overrides = {}) {
  return {
    id: "prod-chaos-budget",
    environments: ["prod"],
    remainingFaults: 1,
    remainingErrorBudgetRatio: 0.08,
    maxExperimentCostRatio: 0.01,
    maxBlastRadius: {
      tenant: "tenant-a",
      camp: "camp-prod",
      maxResources: 1,
    },
    ...overrides,
  };
}

function fixedClock(startIso = "2026-06-28T06:00:00.000Z") {
  const startMs = Date.parse(startIso);
  let tick = 0;
  return () => new Date(startMs + tick++ * 60_000).toISOString();
}
